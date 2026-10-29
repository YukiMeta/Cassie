import Foundation
import AVFoundation
import Vision
import CoreImage

// Finds individual objects in one frame and names them, fully on-device.
// usage: object-detect input.mp4 frame
// Foreground instance segmentation gives each object's pixels and minimal bounding box; image
// classification of that box gives its label. Output boxes are source pixels, top-left origin.
struct Failure: Error, CustomStringConvertible { let description: String }

func frameImage(_ url: URL, _ frame: Int) throws -> CGImage {
    let asset = AVURLAsset(url: url)
    guard let track = asset.tracks(withMediaType: .video).first else { throw Failure(description: "no video track") }
    let reader = try AVAssetReader(asset: asset)
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
    reader.add(output)
    guard reader.startReading() else { throw reader.error ?? Failure(description: "cannot read video") }
    var index = 0
    let context = CIContext()
    while let sample = output.copyNextSampleBuffer() {
        defer { index += 1 }
        if index < frame { continue }
        guard let pixel = CMSampleBufferGetImageBuffer(sample) else { break }
        let image = CIImage(cvPixelBuffer: pixel)
        guard let cg = context.createCGImage(image, from: image.extent) else { break }
        return cg
    }
    throw Failure(description: "frame \(frame) not found")
}

func label(_ image: CGImage) throws -> [(String, Float)] {
    let request = VNClassifyImageRequest()
    try VNImageRequestHandler(cgImage: image).perform([request])
    return (request.results ?? []).filter { $0.confidence > 0.05 }.prefix(3).map { ($0.identifier.replacingOccurrences(of: "_", with: " "), $0.confidence) }
}

func process() throws {
    let a = CommandLine.arguments
    guard a.count == 3, let frame = Int(a[2]), frame >= 0 else { throw Failure(description: "usage: object-detect input.mp4 frame") }
    let image = try frameImage(URL(fileURLWithPath: a[1]), frame)
    let W = image.width, H = image.height
    let request = VNGenerateForegroundInstanceMaskRequest()
    let handler = VNImageRequestHandler(cgImage: image)
    try handler.perform([request])
    var objects: [[String: Any]] = []
    if let observation = request.results?.first {
        let labels = observation.instanceMask
        CVPixelBufferLockBaseAddress(labels, .readOnly)
        let lw = CVPixelBufferGetWidth(labels), lh = CVPixelBufferGetHeight(labels), stride = CVPixelBufferGetBytesPerRow(labels)
        let data = CVPixelBufferGetBaseAddress(labels)!.assumingMemoryBound(to: UInt8.self)
        // Instance segmentation merges a person with what they hold; person segmentation splits them.
        let personRequest = VNGeneratePersonSegmentationRequest()
        personRequest.qualityLevel = .accurate
        personRequest.outputPixelFormat = kCVPixelFormatType_OneComponent8
        try handler.perform([personRequest])
        var isPerson: (Int, Int) -> Bool = { _, _ in false }
        var personPixels: [UInt8] = []
        if let person = personRequest.results?.first?.pixelBuffer {
            CVPixelBufferLockBaseAddress(person, .readOnly)
            let pw = CVPixelBufferGetWidth(person), ph = CVPixelBufferGetHeight(person), ps = CVPixelBufferGetBytesPerRow(person)
            let pd = CVPixelBufferGetBaseAddress(person)!.assumingMemoryBound(to: UInt8.self)
            personPixels = (0..<lh).flatMap { y in (0..<lw).map { x in pd[(y * ph / lh) * ps + (x * pw / lw)] } }
            CVPixelBufferUnlockBaseAddress(person, .readOnly)
            isPerson = { x, y in personPixels[y * lw + x] > 127 }
        }
        typealias Bounds = (Int, Int, Int, Int, Int)
        func grow(_ b: Bounds?, _ x: Int, _ y: Int) -> Bounds { let b = b ?? (x, y, x, y, 0); return (min(b.0, x), min(b.1, y), max(b.2, x), max(b.3, y), b.4 + 1) }
        var parts = [String: (instance: Int, part: String, bounds: Bounds)]()
        for y in 0..<lh { for x in 0..<lw {
            let l = Int(data[y * stride + x]); if l == 0 { continue }
            let part = isPerson(x, y) ? "person" : "object", key = "\(l)-\(part)"
            parts[key] = (l, part, grow(parts[key]?.bounds, x, y))
        } }
        CVPixelBufferUnlockBaseAddress(labels, .readOnly)
        for (_, p) in parts.sorted(by: { $0.value.bounds.4 > $1.value.bounds.4 }) where Double(p.bounds.4) / Double(lw * lh) > 0.003 {
            let b = p.bounds, sx = Double(W) / Double(lw), sy = Double(H) / Double(lh)
            let box = [Double(b.0) * sx, Double(b.1) * sy, Double(b.2 - b.0 + 1) * sx, Double(b.3 - b.1 + 1) * sy].map { ($0 * 10).rounded() / 10 }
            guard let crop = image.cropping(to: CGRect(x: box[0], y: box[1], width: box[2], height: box[3])) else { continue }
            let names = p.part == "person" ? [("person", Float(1))] : try label(crop)
            objects.append(["instance": p.instance, "part": p.part, "box": box, "coverage": Double(b.4) / Double(lw * lh),
                            "label": names.first?.0 ?? "object", "confidence": names.first?.1 ?? 0,
                            "alternatives": names.dropFirst().map { $0.0 }])
        }
    }
    // Objectness saliency proposes boxes for objects that segmentation merged into a bigger instance.
    let saliency = VNGenerateObjectnessBasedSaliencyImageRequest()
    try handler.perform([saliency])
    func iou(_ a: [Double], _ b: [Double]) -> Double {
        let ix = max(0, min(a[0] + a[2], b[0] + b[2]) - max(a[0], b[0])), iy = max(0, min(a[1] + a[3], b[1] + b[3]) - max(a[1], b[1]))
        return ix * iy / (a[2] * a[3] + b[2] * b[3] - ix * iy)
    }
    for salient in saliency.results?.first?.salientObjects ?? [] {
        let r = salient.boundingBox
        let box = [Double(r.minX) * Double(W), (1 - Double(r.maxY)) * Double(H), Double(r.width) * Double(W), Double(r.height) * Double(H)].map { ($0 * 10).rounded() / 10 }
        if box[2] < 16 || box[3] < 16 || objects.contains(where: { iou($0["box"] as! [Double], box) > 0.6 }) { continue }
        guard let crop = image.cropping(to: CGRect(x: box[0], y: box[1], width: box[2], height: box[3])) else { continue }
        let names = try label(crop)
        objects.append(["part": "salient", "box": box, "coverage": Double(r.width * r.height), "label": names.first?.0 ?? "object",
                        "confidence": names.first?.1 ?? 0, "alternatives": names.dropFirst().map { $0.0 }])
    }
    FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: ["frame": frame, "width": W, "height": H, "objects": objects, "backend": "apple-vision/foreground-instance+classify"]))
}

do { try process() } catch { FileHandle.standardError.write("\(error)\n".data(using: .utf8)!); exit(1) }
