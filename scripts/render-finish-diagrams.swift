#!/usr/bin/env swift
import AppKit
import Foundation

// 收尾圖只示範「雙方都前進」的拓樸，不代表目前儲存庫的提交。
let logicalSize = NSSize(width: 300, height: 120)
let scale = 3
let radius: CGFloat = 12
let background = NSColor(calibratedWhite: 0.98, alpha: 1)
let mainColor = NSColor(calibratedRed: 0.40, green: 0.44, blue: 0.50, alpha: 1)
let workColor = NSColor(calibratedRed: 0.13, green: 0.33, blue: 0.78, alpha: 1)
let textColor = NSColor(calibratedRed: 0.15, green: 0.17, blue: 0.20, alpha: 1)

func point(_ horizontal: CGFloat, _ vertical: CGFloat) -> NSPoint {
    NSPoint(x: horizontal, y: logicalSize.height - vertical)
}

func drawLine(_ points: [NSPoint], color: NSColor) {
    guard let first = points.first else { return }
    let path = NSBezierPath()
    path.move(to: first)
    for destination in points.dropFirst() { path.line(to: destination) }
    path.lineWidth = 2
    path.lineJoinStyle = .round
    color.setStroke()
    path.stroke()
}

func drawNode(_ center: NSPoint, label: String, color: NSColor, filled: Bool = false) {
    let circle = NSBezierPath(ovalIn: NSRect(
        x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2
    ))
    (filled ? color : background).setFill()
    circle.fill()
    color.setStroke()
    circle.lineWidth = 2
    circle.stroke()
    let title = NSAttributedString(string: label, attributes: [
        .font: NSFont.systemFont(ofSize: 14, weight: .medium),
        .foregroundColor: filled ? NSColor.white : textColor
    ])
    let size = title.size()
    title.draw(at: NSPoint(x: center.x - size.width / 2, y: center.y - size.height / 2))
}

func drawMerge(squash: Bool) {
    let base = point(22, 35)
    let merge = point(278, 35)
    drawLine([base, merge], color: mainColor)
    drawLine([base, point(105, 85), point(190, 85), merge], color: workColor)
    drawNode(base, label: "A", color: mainColor)
    drawNode(point(105, 35), label: "B", color: mainColor)
    drawNode(point(190, 35), label: "C", color: mainColor)
    drawNode(merge, label: "M", color: workColor, filled: true)
    if squash {
        drawNode(point(147, 85), label: "S", color: workColor)
    } else {
        drawNode(point(105, 85), label: "1", color: workColor)
        drawNode(point(190, 85), label: "2", color: workColor)
    }
}

func drawRebase(squash: Bool) {
    let base = point(22, 60)
    let target = point(140, 60)
    drawLine([base, target], color: mainColor)
    drawLine([target, point(squash ? 228 : 278, 60)], color: workColor)
    drawNode(base, label: "A", color: mainColor)
    drawNode(point(81, 60), label: "B", color: mainColor)
    drawNode(target, label: "C", color: mainColor)
    if squash {
        drawNode(point(228, 60), label: "S′", color: workColor)
    } else {
        drawNode(point(209, 60), label: "1′", color: workColor)
        drawNode(point(278, 60), label: "2′", color: workColor)
    }
}

enum RenderError: Error {
    case cannotCreateBitmap
    case cannotCreateContext
    case cannotEncodePNG
}

func render(to destination: URL, rebase: Bool, squash: Bool) throws {
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
    let transform = NSAffineTransform()
    transform.scale(by: CGFloat(scale))
    transform.concat()
    background.setFill()
    NSRect(origin: .zero, size: logicalSize).fill()
    if rebase { drawRebase(squash: squash) } else { drawMerge(squash: squash) }
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
        let destination = assets.appendingPathComponent("\(name).png")
        try render(to: destination, rebase: rebase, squash: squash)
        print("\(destination.path) (900 × 360 px, 300 × 120 pt)")
    }
} catch {
    fputs("收尾示意圖產生失敗：\(error)\n", stderr)
    exit(1)
}
