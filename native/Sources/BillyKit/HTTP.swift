import Foundation

// Minimal HTTP/1.1 for the local control socket: one request per connection
// ("Connection: close"), bodies framed by Content-Length, chunked encoding, or
// connection close. Pure value types so the parser is testable without sockets.

public struct HTTPRequest: Sendable, Equatable {
    public var method: String
    public var path: String
    public var headers: [(String, String)]
    public var body: Data?

    public init(method: String, path: String, headers: [(String, String)] = [], body: Data? = nil) {
        self.method = method; self.path = path; self.headers = headers; self.body = body
    }

    public static func == (a: HTTPRequest, b: HTTPRequest) -> Bool {
        a.method == b.method && a.path == b.path && a.body == b.body
            && a.headers.map { "\($0.0):\($0.1)" } == b.headers.map { "\($0.0):\($0.1)" }
    }

    /// Wire bytes. Never includes an Origin header: the daemon rejects browser-like requests.
    public func serialize() -> Data {
        var head = "\(method) \(path) HTTP/1.1\r\n"
        var hasLength = false
        for (k, v) in headers where k.lowercased() != "origin" {
            if k.lowercased() == "content-length" { hasLength = true }
            head += "\(k): \(v)\r\n"
        }
        if let body, !hasLength { head += "Content-Length: \(body.count)\r\n" }
        else if body == nil, !hasLength, method != "GET" { head += "Content-Length: 0\r\n" }
        head += "\r\n"
        var d = Data(head.utf8)
        if let body { d.append(body) }
        return d
    }
}

public struct HTTPResponse: Sendable, Equatable {
    public var status: Int
    public var headers: [String: String]   // lower-cased names
    public var body: Data
}

public enum HTTPError: Error, Equatable, CustomStringConvertible {
    case malformed(String)
    case incomplete
    public var description: String {
        switch self {
        case .malformed(let m): return "malformed HTTP response: \(m)"
        case .incomplete: return "connection closed before the response was complete"
        }
    }
}

/// Incremental response parser. Feed bytes as they arrive; `result` becomes
/// non-nil once a full response is available. Call `finish()` at EOF.
public struct HTTPResponseParser: Sendable {
    private var buffer = Data()
    private var head: (status: Int, headers: [String: String], bodyStart: Int)?
    public private(set) var result: HTTPResponse?

    public init() {}

    public mutating func feed(_ bytes: Data) throws {
        guard result == nil else { return }
        buffer.append(bytes)
        try advance(eof: false)
    }

    /// Signals EOF; resolves close-delimited bodies or throws if incomplete.
    public mutating func finish() throws -> HTTPResponse {
        if let result { return result }
        try advance(eof: true)
        guard let result else { throw HTTPError.incomplete }
        return result
    }

    private mutating func advance(eof: Bool) throws {
        if head == nil {
            guard let end = buffer.range(of: Data("\r\n\r\n".utf8)) else {
                if buffer.count > 64 * 1024 { throw HTTPError.malformed("header too large") }
                return
            }
            guard let text = String(data: buffer[buffer.startIndex..<end.lowerBound], encoding: .utf8) else {
                throw HTTPError.malformed("header not UTF-8")
            }
            var lines = text.components(separatedBy: "\r\n")
            let statusLine = lines.removeFirst().split(separator: " ", maxSplits: 2)
            guard statusLine.count >= 2, statusLine[0].hasPrefix("HTTP/1."), let code = Int(statusLine[1]) else {
                throw HTTPError.malformed("bad status line")
            }
            var headers: [String: String] = [:]
            for line in lines {
                guard let colon = line.firstIndex(of: ":") else { throw HTTPError.malformed("bad header line") }
                let name = line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()
                let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
                headers[name] = value
            }
            head = (code, headers, end.upperBound - buffer.startIndex)
        }
        guard let h = head else { return }
        let body = buffer.subdata(in: (buffer.startIndex + h.bodyStart)..<buffer.endIndex)

        if h.headers["transfer-encoding"]?.lowercased().contains("chunked") == true {
            if let decoded = try Self.decodeChunked(body) { result = HTTPResponse(status: h.status, headers: h.headers, body: decoded) }
            else if eof { throw HTTPError.incomplete }
        } else if let lenText = h.headers["content-length"] {
            guard let len = Int(lenText), len >= 0 else { throw HTTPError.malformed("bad content-length") }
            if body.count >= len { result = HTTPResponse(status: h.status, headers: h.headers, body: body.prefix(len)) }
            else if eof { throw HTTPError.incomplete }
        } else if h.status == 204 || h.status == 304 || (100..<200).contains(h.status) {
            result = HTTPResponse(status: h.status, headers: h.headers, body: Data())
        } else if eof {
            result = HTTPResponse(status: h.status, headers: h.headers, body: body)
        }
    }

    /// Returns the decoded body once the terminating zero-size chunk has arrived, else nil.
    static func decodeChunked(_ data: Data) throws -> Data? {
        var out = Data()
        var i = data.startIndex
        let crlf = Data("\r\n".utf8)
        while true {
            guard let lineEnd = data.range(of: crlf, in: i..<data.endIndex) else { return nil }
            guard let sizeLine = String(data: data[i..<lineEnd.lowerBound], encoding: .ascii) else {
                throw HTTPError.malformed("bad chunk size")
            }
            let hex = sizeLine.split(separator: ";").first.map(String.init)?.trimmingCharacters(in: .whitespaces) ?? ""
            guard let size = Int(hex, radix: 16), size >= 0 else { throw HTTPError.malformed("bad chunk size '\(sizeLine)'") }
            let start = lineEnd.upperBound
            // Last chunk: the body is complete (trailers, if any, are ignored).
            if size == 0 { return out }
            guard data.endIndex - start >= size + 2 else { return nil }
            out.append(data[start..<(start + size)])
            i = start + size + 2
        }
    }
}
