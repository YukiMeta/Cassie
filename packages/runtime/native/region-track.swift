import Foundation
import AVFoundation
import Vision
import CoreImage

// Tracks the minimal bounding box of one user-boxed part of a shot through time.
// usage: region-track input.mp4 start-frame frame-count clampX clampY clampW clampH key...
//   key = frame:x,y,w,h  (frame relative to start-frame; boxes in source pixels, top-left origin)
// Between two keys the forward and backward tracks are cross-faded; outside the keys tracking
// extends until a hard cut or until the box content stops matching the previous frame.
struct Failure: Error, CustomStringConvertible { let description: String }

func process() throws {
    let a = CommandLine.arguments
    guard a.count >= 9, let start = Int(a[2]), let count = Int(a[3]), start >= 0, count > 0 else {
        throw Failure(description: "usage: region-track input start count clampX clampY clampW clampH frame:x,y,w,h...")
    }
    let clamp = a[4...7].compactMap { Double($0) }
    guard clamp.count == 4, clamp[2] > 1, clamp[3] > 1 else { throw Failure(description: "invalid clamp box") }
    var keys: [(frame: Int, box: [Double])] = []
    for raw in a[8...] {
        let parts = raw.split(separator: ":")
        guard parts.count == 2, let f = Int(parts[0]), f >= 0, f < count else { throw Failure(description: "invalid key \(raw)") }
        let b = parts[1].split(separator: ",").compactMap { Double($0) }
        guard b.count == 4, b[2] > 1, b[3] > 1, b[0] >= clamp[0] - 0.5, b[1] >= clamp[1] - 0.5,
              b[0] + b[2] <= clamp[0] + clamp[2] + 0.5, b[1] + b[3] <= clamp[1] + clamp[3] + 0.5 else { throw Failure(description: "key box outside clamp: \(raw)") }
        keys.append((f, b))
    }
    keys.sort { $0.frame < $1.frame }
    guard Set(keys.map(\.frame)).count == keys.count else { throw Failure(description: "duplicate key frame") }

    let asset = AVURLAsset(url: URL(fileURLWithPath: a[1]))
    guard let track = asset.tracks(withMediaType: .video).first else { throw Failure(description: "no video track") }
    let H = Double(track.naturalSize.height)
    let reader = try AVAssetReader(asset: asset)
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
    reader.add(output)
    guard reader.startReading() else { throw reader.error ?? Failure(description: "cannot read video") }

    // Frames are cropped to the clamp window and downscaled, so a stacked/grid source tracks inside one panel.
    let scale = min(1.0, 960.0 / max(clamp[2], clamp[3]))
    let fw = Int(clamp[2] * scale), fh = Int(clamp[3] * scale)
    let context = CIContext(options: [.cacheIntermediates: false])
    var frames: [CVPixelBuffer] = []
    var index = 0
    while frames.count < count, let sample = output.copyNextSampleBuffer() {
        defer { index += 1 }
        if index < start { continue }
        try autoreleasepool {
            guard let pixel = CMSampleBufferGetImageBuffer(sample) else { throw Failure(description: "undecodable frame") }
            let originY = H - clamp[1] - clamp[3]
            let image = CIImage(cvPixelBuffer: pixel)
                .cropped(to: CGRect(x: clamp[0], y: originY, width: clamp[2], height: clamp[3]))
                .transformed(by: CGAffineTransform(translationX: -clamp[0], y: -originY))
                .transformed(by: CGAffineTransform(scaleX: scale, y: scale))
            var copy: CVPixelBuffer?
            CVPixelBufferCreate(nil, fw, fh, kCVPixelFormatType_32BGRA, [kCVPixelBufferIOSurfacePropertiesKey as String: [:]] as CFDictionary, &copy)
            guard let target = copy else { throw Failure(description: "cannot allocate frame") }
            context.render(image, to: target)
            frames.append(target)
        }
    }
    guard frames.count == count else { throw Failure(description: "window exceeds media (\(frames.count)/\(count))") }

    // Vision uses normalized, bottom-left coordinates inside the clamp window.
    func toVision(_ b: [Double]) -> CGRect {
        CGRect(x: (b[0] - clamp[0]) / clamp[2], y: 1 - (b[1] - clamp[1] + b[3]) / clamp[3], width: b[2] / clamp[2], height: b[3] / clamp[3])
    }
    func toSource(_ r: CGRect) -> [Double] {
        let x = max(0, min(1, Double(r.minX))), y = max(0, min(1, Double(r.minY)))
        let w = max(0, min(1 - x, Double(r.width))), h = max(0, min(1 - y, Double(r.height)))
        return [clamp[0] + x * clamp[2], clamp[1] + (1 - y - h) * clamp[3], w * clamp[2], h * clamp[3]]
    }
    let gray = CGColorSpaceCreateDeviceGray()
    func thumb(_ frame: CVPixelBuffer, _ rect: CGRect?, _ n: Int) -> [Float] {
        var image = CIImage(cvPixelBuffer: frame)
        if let r = rect {
            let px = CGRect(x: r.minX * CGFloat(fw), y: r.minY * CGFloat(fh), width: max(2, r.width * CGFloat(fw)), height: max(2, r.height * CGFloat(fh)))
            image = image.cropped(to: px).transformed(by: CGAffineTransform(translationX: -px.minX, y: -px.minY))
        }
        let e = image.extent
        image = image.transformed(by: CGAffineTransform(scaleX: CGFloat(n) / e.width, y: CGFloat(n) / e.height))
        var bytes = [UInt8](repeating: 0, count: n * n)
        context.render(image, toBitmap: &bytes, rowBytes: n, bounds: CGRect(x: 0, y: 0, width: n, height: n), format: .L8, colorSpace: gray)
        return bytes.map { Float($0) / 255 }
    }
    func ncc(_ a: [Float], _ b: [Float]) -> Float {
        let ma = a.reduce(0, +) / Float(a.count), mb = b.reduce(0, +) / Float(b.count)
        var num: Float = 0, da: Float = 0, db: Float = 0
        for i in 0..<a.count { let x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y }
        return da * db < 1e-8 ? 1 : num / (da * db).squareRoot()
    }
    let globals = frames.map { thumb($0, nil, 32) }
    func cut(_ i: Int, _ j: Int) -> Bool { zip(globals[i], globals[j]).map { abs($0 - $1) }.reduce(0, +) / Float(globals[i].count) > 0.12 }

    /// Tracks from a key toward `limit` (exclusive); stops at a hard cut or when the box content stops matching.
    func run(from key: Int, box: [Double], toward limit: Int) throws -> [Int: (box: [Double], confidence: Double)] {
        var result: [Int: (box: [Double], confidence: Double)] = [:]
        let step = limit > key ? 1 : -1
        guard key + step != limit else { return result }
        let handler = VNSequenceRequestHandler()
        var observation = VNDetectedObjectObservation(boundingBox: toVision(box))
        try handler.perform([VNTrackObjectRequest(detectedObjectObservation: observation)], on: frames[key])
        var previous = thumb(frames[key], observation.boundingBox, 24), weak = 0, last = key
        for i in stride(from: key + step, to: limit, by: step) {
            if cut(last, i) { break }
            let request = VNTrackObjectRequest(detectedObjectObservation: observation)
            request.trackingLevel = .accurate
            do { try handler.perform([request], on: frames[i]) } catch { break }
            guard let found = request.results?.first as? VNDetectedObjectObservation, found.boundingBox.width > 0.005, found.boundingBox.height > 0.005 else { break }
            let patch = thumb(frames[i], found.boundingBox, 24), similarity = ncc(previous, patch)
            weak = similarity < 0.55 ? weak + 1 : 0
            if weak >= 2 { break }
            observation = found; previous = patch; last = i
            result[i] = (toSource(found.boundingBox), Double(min(found.confidence, max(0, similarity))))
        }
        return result
    }

    var boxes = [[Double]](repeating: [], count: count), confidence = [Double](repeating: 0, count: count)
    var source = [String](repeating: "", count: count)
    for (k, key) in keys.enumerated() {
        boxes[key.frame] = key.box; confidence[key.frame] = 1; source[key.frame] = "key"
        let previous = k > 0 ? keys[k - 1] : nil, next = k + 1 < keys.count ? keys[k + 1] : nil
        let backward = try run(from: key.frame, box: key.box, toward: previous?.frame ?? -1)
        if previous == nil { for (i, v) in backward { boxes[i] = v.box; confidence[i] = v.confidence; source[i] = "track" } }
        guard let next else {
            for (i, v) in try run(from: key.frame, box: key.box, toward: count) { boxes[i] = v.box; confidence[i] = v.confidence; source[i] = "track" }
            continue
        }
        let forward = try run(from: key.frame, box: key.box, toward: next.frame)
        let returning = try run(from: next.frame, box: next.box, toward: key.frame)
        for i in (key.frame + 1)..<next.frame {
            let t = Double(i - key.frame) / Double(next.frame - key.frame)
            let linear = (0..<4).map { key.box[$0] + (next.box[$0] - key.box[$0]) * t }
            switch (forward[i], returning[i]) {
            case let (f?, r?): boxes[i] = (0..<4).map { f.box[$0] * (1 - t) + r.box[$0] * t }; confidence[i] = f.confidence * (1 - t) + r.confidence * t; source[i] = "track"
            case let (f?, nil): boxes[i] = f.box; confidence[i] = f.confidence; source[i] = "track"
            case let (nil, r?): boxes[i] = r.box; confidence[i] = r.confidence; source[i] = "track"
            // Both directions lost the subject between two confirmed keys: interpolate, flagged for review.
            default: boxes[i] = linear; confidence[i] = 0; source[i] = "interpolated"
            }
        }
    }
    let present = boxes.indices.filter { !boxes[$0].isEmpty }
    let rounded = boxes.map { $0.map { ($0 * 10).rounded() / 10 } }
    let json = try JSONSerialization.data(withJSONObject: ["frames": count, "span": [present.first!, present.last!], "keys": keys.map { ["frame": $0.frame, "box": $0.box] }, "boxes": rounded, "confidence": confidence, "source": source, "backend": "apple-vision/track-object+ncc"])
    FileHandle.standardOutput.write(json)
}

do { try process() } catch { FileHandle.standardError.write("\(error)\n".data(using: .utf8)!); exit(1) }
