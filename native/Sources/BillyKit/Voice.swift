import Foundation
import Observation

/// Speech capture seam. The app uses `SystemSpeechRecognizer` (SFSpeechRecognizer
/// + AVAudioEngine); tests inject a fake.
@MainActor
public protocol SpeechRecognizing: AnyObject {
    /// Requests microphone + speech permission. Returns false if denied.
    func authorize() async -> Bool
    /// Starts capturing. `onTranscript` receives the best transcription so far.
    func start(localeID: String, onTranscript: @escaping @MainActor (String) -> Void,
               onError: @escaping @MainActor (String) -> Void) throws
    /// Stops the microphone and returns the final transcription (nil if none).
    func finish() async -> String?
    /// Stops the microphone and discards everything.
    func cancel()
    /// True while the microphone tap is installed / audio engine running.
    var isCapturing: Bool { get }
}

public enum VoiceState: Equatable, Sendable {
    case idle
    case recording
    case sending
    case failed(String)
}

/// Explicit push-to-talk (handoff §15.5, T-UX-06). Nothing is ever captured
/// outside `recording`; cancelling never creates a task; Send goes through the
/// same admission path as typed commands with `source: voice`.
@MainActor @Observable
public final class VoiceController {
    public static let supportedLocales = [("en-US", "English (US)"), ("ar-EG", "العربية (مصر)")]

    public private(set) var state: VoiceState = .idle
    public private(set) var transcript = ""
    public private(set) var startedAt: Date?
    public private(set) var lastTaskID: String?
    public var localeID = "en-US"

    @ObservationIgnored private let recognizer: SpeechRecognizing
    @ObservationIgnored private let submit: @MainActor (String) async -> String?

    /// `submit` posts the text as a task (source voice) and returns its id.
    public init(recognizer: SpeechRecognizing, submit: @escaping @MainActor (String) async -> String?) {
        self.recognizer = recognizer
        self.submit = submit
    }

    public var isRecording: Bool { state == .recording }
    public var microphoneActive: Bool { recognizer.isCapturing }

    public func start() async {
        guard state != .recording, state != .sending else { return }
        guard await recognizer.authorize() else {
            state = .failed("Microphone or speech recognition permission is off. Enable Billy in System Settings → Privacy & Security.")
            return
        }
        transcript = ""
        do {
            try recognizer.start(localeID: localeID,
                                 onTranscript: { [weak self] text in
                                     guard let self, self.state == .recording else { return }
                                     self.transcript = text
                                 },
                                 onError: { [weak self] message in
                                     guard let self, self.state == .recording else { return }
                                     self.recognizer.cancel()
                                     self.state = .failed(message)
                                 })
            startedAt = Date()
            state = .recording
        } catch {
            recognizer.cancel()
            state = .failed("Could not start recording: \(error.localizedDescription)")
        }
    }

    /// Discards the recording. No task is created.
    public func cancel() {
        recognizer.cancel()
        transcript = ""
        startedAt = nil
        state = .idle
    }

    /// Stops recording and submits the recognized text as a voice task.
    @discardableResult
    public func send() async -> String? {
        guard state == .recording else { return nil }
        state = .sending
        let final = await recognizer.finish()
        let text = (final ?? transcript).trimmingCharacters(in: .whitespacesAndNewlines)
        transcript = text
        startedAt = nil
        guard !text.isEmpty else {
            state = .failed("Nothing was recognized; no task was created.")
            return nil
        }
        let id = await submit(text)
        lastTaskID = id
        state = id == nil ? .failed("Billy could not accept the command; see the error banner.") : .idle
        return id
    }

    /// Toggle used by the mic button and keyboard shortcut.
    public func toggle() async {
        if isRecording { await send() } else { await start() }
    }

    public func dismissError() { if case .failed = state { state = .idle } }
}
