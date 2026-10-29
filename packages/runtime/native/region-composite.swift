import Foundation
import AVFoundation
import Vision
import CoreImage

// Object-level replacement of one tracked part of a shot.
// usage: region-composite source.mp4 candidate.mp4 output.mp4 job.json
// job: { start, frames, fps, candFps, srcBoxes[frames][4|0], candBoxes[candFrames][4|0], scale, pad, feather }
// Per frame the new object (instance mask inside its candidate box) is moved onto the source box and
// united with the old object's mask so the old object is covered. The mask is limited to the padded
// source box and feathered; outside it the output is the source, pixel for pixel.
struct Failure: Error, CustomStringConvertible { let description: String }
struct Job: Decodable { let start: Int; let frames: Int; let fps: Double; let candFps: Double; let srcBoxes: [[Double]]; let candBoxes: [[Double]]; let scale: Double; let pad: Double; let feather: Double }

func reader(_ url: URL) throws -> (AVAssetReader, AVAssetReaderTrackOutput, CGSize) {
    let asset = AVURLAsset(url: url)
    guard let track = asset.tracks(withMediaType: .video).first else { throw Failure(description: "no video in \(url.lastPathComponent)") }
    let r = try AVAssetReader(asset: asset)
    let o = AVAssetReaderTrackOutput(track: track, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
    r.add(o)
    guard r.startReading() else { throw r.error ?? Failure(description: "cannot read \(url.lastPathComponent)") }
    return (r, o, track.naturalSize)
}

/// Mask (CI coordinates of the full frame) of the foreground instance that best fills `box` (top-left pixels).
func objectMask(_ image: CIImage, box: [Double], pad: Double, context: CIContext) throws -> CIImage? {
    let H = Double(image.extent.height), W = Double(image.extent.width)
    let x0 = max(0, box[0] - pad), y0 = max(0, box[1] - pad), x1 = min(W, box[0] + box[2] + pad), y1 = min(H, box[1] + box[3] + pad)
    let rect = CGRect(x: x0, y: H - y1, width: x1 - x0, height: y1 - y0)
    guard rect.width > 8, rect.height > 8, let crop = context.createCGImage(image, from: rect) else { return nil }
    let request = VNGenerateForegroundInstanceMaskRequest()
    let handler = VNImageRequestHandler(cgImage: crop)
    try handler.perform([request])
    guard let observation = request.results?.first else { return nil }
    let labels = observation.instanceMask
    CVPixelBufferLockBaseAddress(labels, .readOnly); defer { CVPixelBufferUnlockBaseAddress(labels, .readOnly) }
    let lw = CVPixelBufferGetWidth(labels), lh = CVPixelBufferGetHeight(labels), stride = CVPixelBufferGetBytesPerRow(labels)
    let data = CVPixelBufferGetBaseAddress(labels)!.assumingMemoryBound(to: UInt8.self)
    // The tracked object is the instance covering most of the box interior (box shrunk by 20% per side).
    var counts = [Int: Int]()
    let fx0 = (box[0] + box[2] * 0.2 - x0) / (x1 - x0), fx1 = (box[0] + box[2] * 0.8 - x0) / (x1 - x0)
    let fy0 = (box[1] + box[3] * 0.2 - y0) / (y1 - y0), fy1 = (box[1] + box[3] * 0.8 - y0) / (y1 - y0)
    let ys = max(0, Int(fy0 * Double(lh)))..<min(lh, max(Int(fy0 * Double(lh)) + 1, Int(fy1 * Double(lh))))
    let xs = max(0, Int(fx0 * Double(lw)))..<min(lw, max(Int(fx0 * Double(lw)) + 1, Int(fx1 * Double(lw))))
    for y in ys { for x in xs { let l = Int(data[y * stride + x]); if l > 0 { counts[l, default: 0] += 1 } } }
    guard let best = counts.max(by: { $0.value < $1.value })?.key else { return nil }
    let mask = try observation.generateScaledMaskForImage(forInstances: IndexSet(integer: best), from: handler)
    return CIImage(cvPixelBuffer: mask).transformed(by: CGAffineTransform(translationX: rect.minX, y: rect.minY))
}

func process() throws {
    let a = CommandLine.arguments
    guard a.count == 5 else { throw Failure(description: "usage: region-composite source candidate output job.json") }
    let job = try JSONDecoder().decode(Job.self, from: Data(contentsOf: URL(fileURLWithPath: a[4])))
    let (_, so, size) = try reader(URL(fileURLWithPath: a[1]))
    let (_, co, csize) = try reader(URL(fileURLWithPath: a[2]))
    let W = Int(size.width), H = Int(size.height), Hs = Double(size.height), Hc = Double(csize.height)
    let out = URL(fileURLWithPath: a[3]); try? FileManager.default.removeItem(at: out)
    let writer = try AVAssetWriter(outputURL: out, fileType: .mp4)
    let input = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: W, AVVideoHeightKey: H,
        AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 24_000_000]])
    let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA, kCVPixelBufferWidthKey as String: W, kCVPixelBufferHeightKey as String: H])
    writer.add(input); writer.startWriting(); writer.startSession(atSourceTime: .zero)
    let context = CIContext(options: [.cacheIntermediates: false])

    var candFrames: [CGImage] = []
    while let s = co.copyNextSampleBuffer(), let p = CMSampleBufferGetImageBuffer(s) {
        let image = CIImage(cvPixelBuffer: p)
        if let cg = context.createCGImage(image, from: image.extent) { candFrames.append(cg) }
    }
    guard !candFrames.isEmpty else { throw Failure(description: "candidate has no frames") }
    var index = 0, written = 0, masked = 0
    while written < job.frames, let sample = so.copyNextSampleBuffer() {
        defer { index += 1 }
        if index < job.start { continue }
        try autoreleasepool {
            guard let pixel = CMSampleBufferGetImageBuffer(sample) else { throw Failure(description: "undecodable source frame") }
            let source = CIImage(cvPixelBuffer: pixel)
            var result = source
            let box = written < job.srcBoxes.count ? job.srcBoxes[written] : []
            let ci = min(candFrames.count - 1, max(0, Int((Double(written) / job.fps * job.candFps).rounded())))
            let cb = ci < job.candBoxes.count ? job.candBoxes[ci] : []
            let cand = CIImage(cgImage: candFrames[ci])
            if box.count == 4, cb.count == 4, let newMask = try objectMask(cand, box: cb, pad: job.pad, context: context) {
                let k = job.scale, vx = box[0] + box[2] / 2 - (cb[0] + cb[2] / 2) * k, vy = box[1] + box[3] / 2 - (cb[1] + cb[3] / 2) * k
                let move = CGAffineTransform(a: k, b: 0, c: 0, d: k, tx: vx, ty: Hs - k * Hc - vy)
                var mask = newMask.transformed(by: move)
                if let oldMask = try objectMask(source, box: box, pad: job.pad, context: context) {
                    mask = mask.applyingFilter("CIMaximumCompositing", parameters: [kCIInputBackgroundImageKey: oldMask])
                }
                let window = CGRect(x: box[0] - job.pad, y: Hs - (box[1] + box[3] + job.pad), width: box[2] + job.pad * 2, height: box[3] + job.pad * 2)
                mask = mask.cropped(to: window).applyingGaussianBlur(sigma: job.feather).cropped(to: window)
                let black = CIImage(color: .black).cropped(to: source.extent)
                mask = mask.composited(over: black)
                result = cand.transformed(by: move).applyingFilter("CIBlendWithMask", parameters: [kCIInputBackgroundImageKey: source, kCIInputMaskImageKey: mask]).cropped(to: source.extent)
                masked += 1
            }
            while !input.isReadyForMoreMediaData { Thread.sleep(forTimeInterval: 0.005) }
            var buffer: CVPixelBuffer?
            CVPixelBufferPoolCreatePixelBuffer(nil, adaptor.pixelBufferPool!, &buffer)
            guard let target = buffer else { throw Failure(description: "no output buffer") }
            context.render(result, to: target)
            adaptor.append(target, withPresentationTime: CMTime(value: CMTimeValue(written), timescale: CMTimeScale(job.fps.rounded())))
            written += 1
        }
    }
    input.markAsFinished()
    let done = DispatchSemaphore(value: 0); writer.finishWriting { done.signal() }; done.wait()
    guard writer.status == .completed, written == job.frames else { throw Failure(description: "write failed: \(writer.error?.localizedDescription ?? "\(written)/\(job.frames) frames")") }
    FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: ["frames": written, "masked": masked, "backend": "apple-vision/foreground-instance+coreimage"]))
}

do { try process() } catch { FileHandle.standardError.write("\(error)\n".data(using: .utf8)!); exit(1) }
