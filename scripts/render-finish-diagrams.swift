#!/usr/bin/env swift
import AppKit
import Foundation

// 收尾圖只示範「雙方都前進」的拓樸，不代表目前儲存庫的提交。
let logicalSize = NSSize(width: 320, height: 156)
let scale = 3
let radius: CGFloat = 13

struct DiagramPalette {
    let suffix: String
    let line: NSColor
    let text: NSColor
    let nodeFill: NSColor

    static let light = DiagramPalette(
        suffix: "", line: NSColor(calibratedWhite: 0.36, alpha: 1),
        text: NSColor(calibratedWhite: 0.21, alpha: 1),
        nodeFill: NSColor(calibratedWhite: 0.98, alpha: 1)
    )
    static let dark = DiagramPalette(
        suffix: "-dark", line: NSColor(calibratedWhite: 0.78, alpha: 1),
        text: NSColor(calibratedWhite: 0.88, alpha: 1),
        nodeFill: NSColor(calibratedWhite: 0.14, alpha: 1)
    )
}

func point(_ horizontal: CGFloat, _ vertical: CGFloat) -> NSPoint {
    NSPoint(x: horizontal, y: logicalSize.height - vertical)
}

func drawLine(_ points: [NSPoint], color: NSColor) {
    guard let first = points.first else { return }
    let path = NSBezierPath()
    path.move(to: first)
    for destination in points.dropFirst() { path.line(to: destination) }
    path.lineWidth = 2
    path.lineCapStyle = .round
    path.lineJoinStyle = .round
    color.setStroke()
    path.stroke()
}

func drawText(_ text: String, at center: NSPoint, color: NSColor, size: CGFloat = 13) {
    let title = NSAttributedString(string: text, attributes: [
        .font: NSFont.systemFont(ofSize: size, weight: .medium),
        .foregroundColor: color
    ])
    let bounds = title.size()
    title.draw(at: NSPoint(x: center.x - bounds.width / 2, y: center.y - bounds.height / 2))
}

func drawNode(_ center: NSPoint, label: String, palette: DiagramPalette, filled: Bool = false) {
    let circle = NSBezierPath(ovalIn: NSRect(
        x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2
    ))
    (filled ? palette.text : palette.nodeFill).setFill()
    circle.fill()
    palette.line.setStroke()
    circle.lineWidth = 2
    circle.stroke()
    drawText(label, at: center, color: filled ? palette.nodeFill : palette.text, size: 15)
}

func drawMerge(squash: Bool, palette: DiagramPalette) {
    let base = point(24, 56)
    let merge = point(296, 56)
    drawText("目標原有進度", at: point(112, 20), color: palette.text)
    drawLine([base, merge], color: palette.line)
    drawLine([base, point(96, 100), point(216, 100), merge], color: palette.line)
    drawNode(base, label: "A", palette: palette)
    drawNode(point(112, 56), label: "B", palette: palette)
    drawNode(point(200, 56), label: "C", palette: palette)
    drawNode(merge, label: "M", palette: palette, filled: true)
    if squash {
        drawNode(point(156, 100), label: "S", palette: palette)
    } else {
        drawNode(point(112, 100), label: "1", palette: palette)
        drawNode(point(200, 100), label: "2", palette: palette)
    }
    let caption = squash ? "先合成 S，再用 M 接起來" : "1、2 保持原樣，M 把兩邊接起來"
    drawText(caption, at: point(160, 140), color: palette.text)
}

func drawRebase(squash: Bool, palette: DiagramPalette) {
    let base = point(24, 56)
    let target = point(144, 56)
    drawText("目標原有進度", at: point(84, 20), color: palette.text)
    drawText("重播後的提交", at: point(250, 20), color: palette.text)
    drawLine([base, point(squash ? 250 : 296, 56)], color: palette.line)
    drawNode(base, label: "A", palette: palette)
    drawNode(point(84, 56), label: "B", palette: palette)
    drawNode(target, label: "C", palette: palette)
    if squash {
        drawNode(point(250, 56), label: "S′", palette: palette)
    } else {
        drawNode(point(220, 56), label: "1′", palette: palette)
        drawNode(point(296, 56), label: "2′", palette: palette)
    }
    let caption = squash ? "S′ 是合成後再重播的提交" : "1、2 重播成 1′、2′，編號改變"
    drawText(caption, at: point(160, 104), color: palette.text)
}

enum RenderError: Error {
    case cannotCreateBitmap
    case cannotCreateContext
    case cannotEncodePNG
}

func render(to destination: URL, rebase: Bool, squash: Bool, palette: DiagramPalette) throws {
    guard let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: Int(logicalSize.width) * scale,
        pixelsHigh: Int(logicalSize.height) * scale, bitsPerSample: 8,
        samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
    ) else { throw RenderError.cannotCreateBitmap }
    guard let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
        throw RenderError.cannotCreateContext
    }
    NSGraphicsContext.saveGraphicsState()
    defer { NSGraphicsContext.restoreGraphicsState() }
    NSGraphicsContext.current = context
    context.cgContext.clear(CGRect(x: 0, y: 0, width: bitmap.pixelsWide, height: bitmap.pixelsHigh))
    let transform = NSAffineTransform()
    transform.scale(by: CGFloat(scale))
    transform.concat()
    if rebase { drawRebase(squash: squash, palette: palette) }
    else { drawMerge(squash: squash, palette: palette) }
    context.flushGraphics()
    bitmap.size = logicalSize
    guard let png = bitmap.representation(using: .png, properties: [:]) else {
        throw RenderError.cannotEncodePNG
    }
    try png.write(to: destination, options: .atomic)
}

let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
let assets = root.appendingPathComponent("src/assets", isDirectory: true)
do {
    try FileManager.default.createDirectory(at: assets, withIntermediateDirectories: true)
    for (name, rebase, squash) in [
        ("finish-merge", false, false), ("finish-rebase", true, false),
        ("finish-merge-squash", false, true), ("finish-rebase-squash", true, true)
    ] {
        for palette in [DiagramPalette.light, DiagramPalette.dark] {
            let destination = assets.appendingPathComponent("\(name)\(palette.suffix).png")
            try render(to: destination, rebase: rebase, squash: squash, palette: palette)
            print("\(destination.path) (960 × 468 px, 320 × 156 pt)")
        }
    }
} catch {
    fputs("收尾示意圖產生失敗：\(error)\n", stderr)
    exit(1)
}
