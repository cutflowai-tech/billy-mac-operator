// billy-ocr: on-device text recognition for deterministic visual verification.
// Usage: billy-ocr <image-file>   -> JSON {"lines":[{"text":..,"confidence":..}]} on stdout.
// Uses Apple's Vision framework locally; no network, no model calls. Small crops are
// upscaled and recognised both as-is and colour-inverted (light-on-dark UI text such as
// a lone calculator digit is otherwise often missed); results are the union.
import Foundation
import Vision
import ImageIO
import CoreImage

guard CommandLine.arguments.count == 2 else {
    FileHandle.standardError.write(Data("usage: billy-ocr <image>\n".utf8)); exit(2)
}
let url = URL(fileURLWithPath: CommandLine.arguments[1])
guard let src = CGImageSourceCreateWithURL(url as CFURL, nil), let image = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
    FileHandle.standardError.write(Data("cannot read image\n".utf8)); exit(1)
}
struct Line: Encodable { let text: String; let confidence: Float }
let ctx = CIContext()
let base = CIImage(cgImage: image)
let scale: CGFloat = image.width < 1000 ? 4 : 1
let up = base.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
var seen = Set<String>()
var lines: [Line] = []
for variant in [up, up.applyingFilter("CIColorInvert")] {
    guard let cg = ctx.createCGImage(variant, from: variant.extent) else { continue }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false
    request.minimumTextHeight = 0
    if #available(macOS 13.0, *) { request.revision = VNRecognizeTextRequestRevision3 }
    do { try VNImageRequestHandler(cgImage: cg).perform([request]) } catch {
        FileHandle.standardError.write(Data("vision failed: \(error)\n".utf8)); exit(1)
    }
    for obs in request.results ?? [] {
        guard let c = obs.topCandidates(1).first, !seen.contains(c.string) else { continue }
        seen.insert(c.string); lines.append(Line(text: c.string, confidence: c.confidence))
    }
}
let out = try JSONEncoder().encode(["lines": lines])
FileHandle.standardOutput.write(out); FileHandle.standardOutput.write(Data("\n".utf8))
