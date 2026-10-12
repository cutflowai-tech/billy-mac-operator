import Foundation
import Darwin

public enum TransportError: Error, Equatable, CustomStringConvertible {
    case pathTooLong(String)
    case socket(String, Int32)
    case timeout
    public var description: String {
        switch self {
        case .pathTooLong(let p): return "socket path too long: \(p)"
        case .socket(let op, let e): return "\(op) failed: \(String(cString: strerror(e)))"
        case .timeout: return "timed out talking to billyd"
        }
    }
    /// The daemon is simply not running (no socket file or nobody listening).
    public var isNotRunning: Bool {
        if case .socket("connect", let e) = self { return e == ENOENT || e == ECONNREFUSED }
        return false
    }
}

/// Blocking request/response over an AF_UNIX stream socket. Callers must run it
/// off the main thread (BillyClient does).
public struct UnixSocketTransport: Sendable {
    public let path: String
    public let timeout: TimeInterval

    public init(path: String, timeout: TimeInterval = 10) {
        self.path = path; self.timeout = timeout
    }

    public func roundTrip(_ request: HTTPRequest) throws -> HTTPResponse {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw TransportError.socket("socket", errno) }
        defer { close(fd) }

        var on: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
        var tv = timeval(tv_sec: Int(timeout), tv_usec: Int32((timeout - floor(timeout)) * 1e6))
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        let capacity = MemoryLayout.size(ofValue: addr.sun_path)
        guard bytes.count < capacity else { throw TransportError.pathTooLong(path) }
        withUnsafeMutableBytes(of: &addr.sun_path) { raw in
            raw.copyBytes(from: bytes)
            raw[bytes.count] = 0
        }
        addr.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        let rc = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard rc == 0 else { throw TransportError.socket("connect", errno) }

        let out = request.serialize()
        try out.withUnsafeBytes { (buf: UnsafeRawBufferPointer) in
            var sent = 0
            while sent < buf.count {
                let n = write(fd, buf.baseAddress! + sent, buf.count - sent)
                if n < 0 {
                    if errno == EINTR { continue }
                    throw errno == EAGAIN ? TransportError.timeout : TransportError.socket("write", errno)
                }
                sent += n
            }
        }

        var parser = HTTPResponseParser()
        var chunk = [UInt8](repeating: 0, count: 16 * 1024)
        while true {
            let n = chunk.withUnsafeMutableBytes { read(fd, $0.baseAddress, $0.count) }
            if n < 0 {
                if errno == EINTR { continue }
                throw errno == EAGAIN ? TransportError.timeout : TransportError.socket("read", errno)
            }
            if n == 0 { return try parser.finish() }
            try parser.feed(Data(chunk[0..<n]))
            if let r = parser.result { return r }
        }
    }
}
