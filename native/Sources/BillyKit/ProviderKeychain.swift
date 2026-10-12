import Foundation
import Security

/// Writes the Anthropic API key to the login Keychain item the core reads
/// (service com.billy.provider.anthropic, account default). The value is never
/// logged, shown, or sent to the daemon; the core reads it with /usr/bin/security,
/// so that tool is added to the item's access list to avoid a prompt per read.
public enum ProviderKeychain {
    public static let service = "com.billy.provider.anthropic"
    public static let account = "default"

    /// Terminal alternative shown in Settings (prompts for the key; never on argv).
    public static let terminalCommand = "security add-generic-password -U -s com.billy.provider.anthropic -a default -w"

    public enum Failure: Error, CustomStringConvertible {
        case empty
        case status(OSStatus)
        public var description: String {
            switch self {
            case .empty: return "The key is empty."
            case .status(let s): return (SecCopyErrorMessageString(s, nil) as String?) ?? "Keychain error \(s)"
            }
        }
    }

    public static func exists() -> Bool {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                kSecAttrAccount as String: account, kSecReturnAttributes as String: true]
        return SecItemCopyMatching(q as CFDictionary, nil) == errSecSuccess
    }

    public static func store(_ key: String) throws {
        let value = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { throw Failure.empty }
        let base: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                   kSecAttrAccount as String: account]
        // Replace rather than update so the access list is always ours.
        SecItemDelete(base as CFDictionary)
        var add = base
        add[kSecValueData as String] = Data(value.utf8)
        add[kSecAttrLabel as String] = "Billy: Anthropic API key"
        if let access = makeAccess() { add[kSecAttrAccess as String] = access }
        let s = SecItemAdd(add as CFDictionary, nil)
        guard s == errSecSuccess else { throw Failure.status(s) }
    }

    /// Trusted readers: this app and /usr/bin/security (used by billyd).
    /// SecAccess is the legacy file-keychain ACL API; it is deprecated but still
    /// the only way to pre-authorize another executable for a login-keychain item.
    private static func makeAccess() -> SecAccess? {
        var me: SecTrustedApplication?
        var tool: SecTrustedApplication?
        guard SecTrustedApplicationCreateFromPath(nil, &me) == errSecSuccess,
              SecTrustedApplicationCreateFromPath("/usr/bin/security", &tool) == errSecSuccess,
              let me, let tool else { return nil }
        var access: SecAccess?
        let s = SecAccessCreate("Billy: Anthropic API key" as CFString, [me, tool] as CFArray, &access)
        return s == errSecSuccess ? access : nil
    }
}
