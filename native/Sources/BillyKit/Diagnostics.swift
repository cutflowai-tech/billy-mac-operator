import Foundation

/// Builds the "Export diagnostics" JSON. The core already redacts known secrets;
/// this additionally strips the home directory, bearer-like tokens and API keys
/// so the file can be shared for support.
public enum DiagnosticsExport {
    public struct Bundle: Codable, Sendable {
        public var exported_at: String
        public var app_version: String
        public var os_version: String
        public var connection: String
        public var status: StatusResponse?
        public var doctor: DoctorReport?
        public var service: String
    }

    public static func make(status: StatusResponse?, doctor: DoctorReport?, connection: ConnectionState,
                            service: String, appVersion: String, now: Date = Date(),
                            home: String = NSHomeDirectory()) throws -> Data {
        let b = Bundle(exported_at: ISODate.format(now), app_version: appVersion,
                       os_version: ProcessInfo.processInfo.operatingSystemVersionString,
                       connection: String(describing: connection), status: status, doctor: doctor, service: service)
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        let text = String(decoding: try enc.encode(b), as: UTF8.self)
        return Data(redact(text, home: home).utf8)
    }

    /// Replaces the home path with "~" and masks credential-looking strings.
    public static func redact(_ text: String, home: String = NSHomeDirectory()) -> String {
        var out = text
        if home.count > 1 { out = out.replacingOccurrences(of: home, with: "~") }
        let patterns = [
            #"sk-ant-[A-Za-z0-9_\-]{8,}"#,                // Anthropic keys
            #"(?i)bearer\s+[A-Za-z0-9._\-]{16,}"#,          // bearer tokens
            #"\b\d{6,}:[A-Za-z0-9_\-]{30,}\b"#,             // Telegram bot tokens
        ]
        for p in patterns {
            out = out.replacingOccurrences(of: p, with: "[REDACTED]", options: .regularExpression)
        }
        return out
    }
}
