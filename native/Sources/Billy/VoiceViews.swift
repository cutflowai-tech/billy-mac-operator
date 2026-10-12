import BillyKit
import SwiftUI

/// Push-to-talk: click to start, click again (or Send) to submit; Cancel discards.
struct MicButton: View {
    @Environment(VoiceController.self) private var voice

    var body: some View {
        @Bindable var voice = voice
        HStack(spacing: 4) {
            Picker("Language", selection: $voice.localeID) {
                ForEach(VoiceController.supportedLocales, id: \.0) { id, name in Text(name).tag(id) }
            }
            .labelsHidden()
            .fixedSize()
            .disabled(voice.state != .idle)
            .accessibilityLabel("Voice language")

            Button { Task { await voice.toggle() } } label: {
                Image(systemName: voice.isRecording ? "stop.circle.fill" : "mic.fill")
                    .foregroundStyle(voice.isRecording ? .red : .primary)
                    .frame(width: 20)
            }
            .disabled(voice.state == .sending)
            .help(voice.isRecording ? "Stop and send (⌘⇧V)" : "Push to talk (⌘⇧V)")
            .accessibilityLabel(voice.isRecording ? "Stop recording and send voice command" : "Start voice command")
        }
    }
}

/// Recording indicator, elapsed time, live transcript and Cancel / Send.
struct VoiceStrip: View {
    @Environment(VoiceController.self) private var voice

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            switch voice.state {
            case .recording:
                TimelineView(.periodic(from: .now, by: 0.5)) { ctx in
                    HStack(spacing: 6) {
                        Circle().fill(.red).frame(width: 10, height: 10)
                            .opacity(Int(ctx.date.timeIntervalSinceReferenceDate * 2) % 2 == 0 ? 1 : 0.35)
                        Text("Recording \(elapsed(at: ctx.date))").font(.callout.monospacedDigit()).foregroundStyle(.red)
                    }
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Recording in progress")
                Text(voice.transcript.isEmpty ? "Listening…" : voice.transcript)
                    .foregroundStyle(voice.transcript.isEmpty ? .secondary : .primary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityLabel("Live transcript: \(voice.transcript)")
                Button("Cancel", role: .cancel) { voice.cancel() }
                    .keyboardShortcut(.escape, modifiers: [])
                    .accessibilityLabel("Cancel recording; no task is created")
                Button("Send") { Task { await voice.send() } }
                    .buttonStyle(.borderedProminent)
                    .accessibilityLabel("Send the recognized text as a task")
            case .sending:
                ProgressView().controlSize(.small)
                Text("Sending “\(voice.transcript)”…").frame(maxWidth: .infinity, alignment: .leading)
            case .failed(let m):
                Image(systemName: "exclamationmark.triangle").foregroundStyle(.orange).accessibilityHidden(true)
                Text(m).frame(maxWidth: .infinity, alignment: .leading)
                Button("OK") { voice.dismissError() }.accessibilityLabel("Dismiss voice error")
            case .idle:
                EmptyView()
            }
        }
        .padding(8)
        .background(.red.opacity(voice.isRecording ? 0.08 : 0.0), in: RoundedRectangle(cornerRadius: 8))
    }

    private func elapsed(at now: Date) -> String {
        let s = Int(now.timeIntervalSince(voice.startedAt ?? now))
        return String(format: "%d:%02d", s / 60, s % 60)
    }
}
