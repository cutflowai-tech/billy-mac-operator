import Darwin
import Foundation

/// In-process HTTP/1.1 server on a Unix domain socket, standing in for billyd.
/// Records every request and answers from a route closure.
final class FakeDaemon: @unchecked Sendable {
    struct Recorded: Sendable {
        var method: String
        var path: String
        var headers: [String: String]   // lower-cased names
        var body: Data
        var json: [String: Any]? { (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] }
    }

    enum Reply {
        case json(Int, String)
        case chunked(Int, String, chunkSize: Int)
        case closeDelimited(Int, String)
    }

    let dir: URL
    var socketPath: String { dir.appendingPathComponent("run/billyd.sock").path }
    let token = "test-token-\(UUID().uuidString.prefix(8))"

    private let lock = NSLock()
    private var _requests: [Recorded] = []
    var requests: [Recorded] { lock.withLock { _requests } }
    var route: @Sendable (Recorded) -> Reply

    private var fd: Int32 = -1
    private var thread: Thread?

    init(route: @escaping @Sendable (Recorded) -> Reply) throws {
        // Short path: sockaddr_un.sun_path is 104 bytes on macOS.
        dir = URL(fileURLWithPath: "/tmp").appendingPathComponent("bt-\(getpid())-\(UUID().uuidString.prefix(6))")
        self.route = route
        try FileManager.default.createDirectory(at: dir.appendingPathComponent("run"), withIntermediateDirectories: true)
        try (token + "\n").write(to: dir.appendingPathComponent("run/api.token"), atomically: true, encoding: .utf8)
        try listen()
    }

    private func listen() throws {
        fd = socket(AF_UNIX, SOCK_STREAM, 0)
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(socketPath.utf8)
        withUnsafeMutableBytes(of: &addr.sun_path) { raw in raw.copyBytes(from: bytes); raw[bytes.count] = 0 }
        addr.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        let rc = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        guard rc == 0, Darwin.listen(fd, 16) == 0 else { throw NSError(domain: "FakeDaemon", code: Int(errno)) }
        let serverFD = fd
        let t = Thread { [weak self] in
            while true {
                let c = accept(serverFD, nil, nil)
                if c < 0 { return }   // closed
                self?.serve(c)
            }
        }
        t.start()
        thread = t
    }

    private func serve(_ c: Int32) {
        defer { close(c) }
        var on: Int32 = 1
        setsockopt(c, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
        var buf = Data()
        var chunk = [UInt8](repeating: 0, count: 4096)
        var headerEnd: Range<Data.Index>?
        var contentLength = 0
        while true {
            let n = chunk.withUnsafeMutableBytes { read(c, $0.baseAddress, $0.count) }
            if n <= 0 { return }
            buf.append(contentsOf: chunk[0..<n])
            if headerEnd == nil, let r = buf.range(of: Data("\r\n\r\n".utf8)) {
                headerEnd = r
                let head = String(decoding: buf[..<r.lowerBound], as: UTF8.self)
                for line in head.components(separatedBy: "\r\n").dropFirst() where line.lowercased().hasPrefix("content-length:") {
                    contentLength = Int(line.split(separator: ":")[1].trimmingCharacters(in: .whitespaces)) ?? 0
                }
            }
            if let r = headerEnd, buf.count - r.upperBound >= contentLength { break }
        }
        let r = headerEnd!
        var lines = String(decoding: buf[..<r.lowerBound], as: UTF8.self).components(separatedBy: "\r\n")
        let reqLine = lines.removeFirst().split(separator: " ")
        var headers: [String: String] = [:]
        for l in lines {
            if let i = l.firstIndex(of: ":") {
                headers[l[..<i].lowercased()] = l[l.index(after: i)...].trimmingCharacters(in: .whitespaces)
            }
        }
        let rec = Recorded(method: String(reqLine[0]), path: String(reqLine[1]), headers: headers,
                           body: buf.subdata(in: r.upperBound..<(r.upperBound + contentLength)))
        lock.withLock { _requests.append(rec) }

        // Same auth rule as the real daemon.
        let reply: Reply = (headers["authorization"] != "Bearer \(token)" || headers["origin"] != nil)
            ? .json(401, #"{"error":"unauthorized"}"#) : route(rec)
        func send(_ s: String) { _ = s.withCString { write(c, $0, strlen($0)) } }
        func sendData(_ d: Data) { d.withUnsafeBytes { _ = write(c, $0.baseAddress, $0.count) } }
        switch reply {
        case .json(let status, let body):
            send("HTTP/1.1 \(status) X\r\ncontent-type: application/json\r\ncontent-length: \(body.utf8.count)\r\nconnection: close\r\n\r\n")
            send(body)
        case .chunked(let status, let body, let size):
            send("HTTP/1.1 \(status) X\r\ncontent-type: application/json\r\ntransfer-encoding: chunked\r\n\r\n")
            let bytes = Data(body.utf8)
            var i = 0
            while i < bytes.count {
                let part = bytes[i..<min(i + size, bytes.count)]
                send(String(part.count, radix: 16) + "\r\n")
                sendData(Data(part))
                send("\r\n")
                usleep(1000)   // force the client to read in pieces
                i += size
            }
            send("0\r\n\r\n")
        case .closeDelimited(let status, let body):
            send("HTTP/1.1 \(status) X\r\ncontent-type: application/json\r\n\r\n")
            send(body)
        }
    }

    func shutdown() {
        if fd >= 0 { Darwin.shutdown(fd, SHUT_RDWR); close(fd); fd = -1 }
        try? FileManager.default.removeItem(at: dir)
    }
}
