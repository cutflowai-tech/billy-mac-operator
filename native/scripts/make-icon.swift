// Draws Billy's 1024×1024 app icon PNG with CoreGraphics (no assets checked in).
//   swift scripts/make-icon.swift <out.png>
import AppKit

let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "AppIcon-1024.png"
let size = 1024
let cs = CGColorSpace(name: CGColorSpace.sRGB)!
guard let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0, space: cs,
                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { fatalError("no context") }

// Rounded-square tile with a diagonal gradient (macOS icon grid: ~824pt tile, 100pt inset).
let tile = CGRect(x: 100, y: 100, width: 824, height: 824)
let path = CGPath(roundedRect: tile, cornerWidth: 185, cornerHeight: 185, transform: nil)
ctx.saveGState()
ctx.setShadow(offset: CGSize(width: 0, height: -12), blur: 28, color: CGColor(gray: 0, alpha: 0.35))
ctx.addPath(path); ctx.setFillColor(CGColor(red: 0.12, green: 0.16, blue: 0.32, alpha: 1)); ctx.fillPath()
ctx.restoreGState()
ctx.saveGState()
ctx.addPath(path); ctx.clip()
let gradient = CGGradient(colorsSpace: cs, colors: [
    CGColor(red: 0.20, green: 0.42, blue: 0.98, alpha: 1),
    CGColor(red: 0.42, green: 0.22, blue: 0.86, alpha: 1),
] as CFArray, locations: [0, 1])!
ctx.drawLinearGradient(gradient, start: CGPoint(x: 100, y: 924), end: CGPoint(x: 924, y: 100), options: [])
ctx.restoreGState()

// "B" glyph.
let ns = NSGraphicsContext(cgContext: ctx, flipped: false)
NSGraphicsContext.current = ns
let font = NSFont.systemFont(ofSize: 560, weight: .heavy)
let glyph = NSAttributedString(string: "B", attributes: [.font: font, .foregroundColor: NSColor.white])
let gs = glyph.size()
glyph.draw(at: NSPoint(x: (CGFloat(size) - gs.width) / 2, y: (CGFloat(size) - gs.height) / 2 - 10))

// Status dot (Billy's "working" indicator).
ctx.setFillColor(CGColor(red: 0.20, green: 0.85, blue: 0.45, alpha: 1))
ctx.fillEllipse(in: CGRect(x: 700, y: 700, width: 130, height: 130))
ctx.setStrokeColor(CGColor(gray: 1, alpha: 1)); ctx.setLineWidth(18)
ctx.strokeEllipse(in: CGRect(x: 700, y: 700, width: 130, height: 130))

let image = ctx.makeImage()!
let rep = NSBitmapImageRep(cgImage: image)
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
print("wrote \(out)")
