@preconcurrency import AVFoundation
@preconcurrency import Speech
import Foundation

public enum SpeechError: Error, LocalizedError {
    case unavailable(String)
    public var errorDescription: String? {
        switch self { case .unavailable(let l): return "Speech recognition is not available for \(l) on this Mac." }
    }
}

/// SFSpeechRecognizer + AVAudioEngine push-to-talk capture. Prefers on-device
/// recognition when the locale supports it. The input tap is removed and the
/// engine stopped on every exit path (finish, cancel, error).
@MainActor
public final class SystemSpeechRecognizer: SpeechRecognizing {
    private var engine: AVAudioEngine?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var latest = ""
    private var finalWaiter: CheckedContinuation<String?, Never>?

    public init() {}

    public var isCapturing: Bool { engine?.isRunning ?? false }

    public func authorize() async -> Bool {
        let speech = await withCheckedContinuation { (c: CheckedContinuation<SFSpeechRecognizerAuthorizationStatus, Never>) in
            SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0) }
        }
        guard speech == .authorized else { return false }
        return await AVCaptureDevice.requestAccess(for: .audio)
    }

    public func start(localeID: String, onTranscript: @escaping @MainActor (String) -> Void,
                      onError: @escaping @MainActor (String) -> Void) throws {
        stopAudio()
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeID)), recognizer.isAvailable else {
            throw SpeechError.unavailable(localeID)
        }
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        if recognizer.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }

        let engine = AVAudioEngine()
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        Self.installTap(on: input, format: format, feeding: request)
        engine.prepare()
        try engine.start()

        latest = ""
        self.engine = engine
        self.request = request
        self.task = recognizer.recognitionTask(with: request, resultHandler: Self.resultHandler { [weak self] text, isFinal, message in
            guard let self else { return }
            if let text { self.latest = text; onTranscript(text) }
            if isFinal || message != nil { self.resolveFinal() }
            if let message, !isFinal, self.isCapturing { onError(message) }
        })
    }

    // The audio tap and recognition callbacks run on background threads, so they
    // are built in nonisolated context and hop to the main actor explicitly.
    nonisolated private static func installTap(on input: AVAudioInputNode, format: AVAudioFormat,
                                               feeding request: SFSpeechAudioBufferRecognitionRequest) {
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in request.append(buffer) }
    }

    nonisolated private static func resultHandler(_ deliver: @escaping @MainActor (String?, Bool, String?) -> Void)
        -> (SFSpeechRecognitionResult?, Error?) -> Void {
        return { result, error in
            let text = result?.bestTranscription.formattedString
            let isFinal = result?.isFinal ?? false
            let message = error?.localizedDescription
            Task { @MainActor in deliver(text, isFinal, message) }
        }
    }

    public func finish() async -> String? {
        guard request != nil else { return latest.isEmpty ? nil : latest }
        stopAudio()                // microphone off immediately
        request?.endAudio()        // let the recognizer flush its final result
        let text: String? = await withCheckedContinuation { c in
            finalWaiter = c
            Task { @MainActor [weak self] in
                try? await Task.sleep(for: .seconds(2))   // don't wait forever for a final result
                self?.resolveFinal()
            }
        }
        task?.cancel()
        task = nil
        request = nil
        return text
    }

    public func cancel() {
        stopAudio()
        task?.cancel()
        task = nil
        request = nil
        latest = ""
        resolveFinal()
    }

    private func resolveFinal() {
        guard let w = finalWaiter else { return }
        finalWaiter = nil
        w.resume(returning: latest.isEmpty ? nil : latest)
    }

    private func stopAudio() {
        guard let engine else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        self.engine = nil
    }
}
