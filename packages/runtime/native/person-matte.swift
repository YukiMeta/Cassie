import Foundation
import AVFoundation
import Vision
import CoreImage
import ImageIO
import UniformTypeIdentifiers

// Local macOS person segmentation. Input must be normalized upright CFR video.
// This request segments all people; callers must verify a single-person shot.
func process() throws {
    guard CommandLine.arguments.count == 5,
          let start = Int(CommandLine.arguments[3]), let count = Int(CommandLine.arguments[4]), start >= 0, count > 0 else {
        throw NSError(domain: "Cassie", code: 1, userInfo: [NSLocalizedDescriptionKey: "usage: person-matte input.mp4 output-directory start-frame frame-count"])
    }
    let input = URL(fileURLWithPath: CommandLine.arguments[1])
    let output = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
    try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
    let asset = AVURLAsset(url: input)
    guard let track = asset.tracks(withMediaType: .video).first else { throw NSError(domain: "Cassie", code: 2) }
    let reader = try AVAssetReader(asset: asset)
    let decoder = AVAssetReaderTrackOutput(track: track, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
    decoder.alwaysCopiesSampleData = false
    reader.add(decoder)
    guard reader.startReading() else { throw reader.error ?? NSError(domain: "Cassie", code: 3) }
    let request = VNGeneratePersonSegmentationRequest()
    request.qualityLevel = .accurate
    request.outputPixelFormat = kCVPixelFormatType_OneComponent8
    let sequence = VNSequenceRequestHandler()
    let context = CIContext(options: [.cacheIntermediates: false])
    let colorSpace = CGColorSpaceCreateDeviceGray()
    var index = 0, written = 0
    var boxes: [[String: Any]] = []
    while written < count, let sample = decoder.copyNextSampleBuffer() {
        defer { index += 1 }
        if index < start { continue }
        try autoreleasepool {
            guard let pixel = CMSampleBufferGetImageBuffer(sample) else { throw NSError(domain: "Cassie", code: 4) }
            try sequence.perform([request], on: pixel, orientation: .up)
            guard let mask = request.results?.first?.pixelBuffer else { throw NSError(domain: "Cassie", code: 5, userInfo: [NSLocalizedDescriptionKey: "Vision returned no matte"] ) }
            let width = CVPixelBufferGetWidth(pixel), height = CVPixelBufferGetHeight(pixel)
            let mw = CVPixelBufferGetWidth(mask), mh = CVPixelBufferGetHeight(mask)
            let image = CIImage(cvPixelBuffer: mask).transformed(by: CGAffineTransform(scaleX: CGFloat(width)/CGFloat(mw), y: CGFloat(height)/CGFloat(mh)))
            let target = output.appendingPathComponent(String(format: "%06d.png", written))
            try context.writePNGRepresentation(of: image, to: target, format: .L8, colorSpace: colorSpace)
            CVPixelBufferLockBaseAddress(mask, .readOnly)
            if let base = CVPixelBufferGetBaseAddress(mask) {
                let data = base.assumingMemoryBound(to: UInt8.self), stride = CVPixelBufferGetBytesPerRow(mask)
                var minX = mw, minY = mh, maxX = -1, maxY = -1, covered = 0
                for y in 0..<mh { for x in 0..<mw { if data[y*stride+x] > 127 { minX = min(minX,x); minY = min(minY,y); maxX = max(maxX,x); maxY = max(maxY,y); covered += 1 } } }
                boxes.append(["frame": written, "coverage": Double(covered)/Double(mw*mh), "box": maxX < 0 ? [] : [Double(minX)/Double(mw),Double(minY)/Double(mh),Double(maxX+1)/Double(mw),Double(maxY+1)/Double(mh)]])
            }
            CVPixelBufferUnlockBaseAddress(mask, .readOnly)
            written += 1
            if written % 12 == 0 { FileHandle.standardError.write(Data("matte \(written)/\(count)\n".utf8)) }
        }
    }
    reader.cancelReading()
    guard written == count else { throw NSError(domain: "Cassie", code: 6, userInfo: [NSLocalizedDescriptionKey: "Decoded \(written), expected \(count) frames"]) }
    let metadata: [String: Any] = ["schema": "cassie/person-matte-analysis@1", "backend": "apple-vision", "frames": written, "boxes": boxes]
    try JSONSerialization.data(withJSONObject: metadata, options: [.sortedKeys]).write(to: output.appendingPathComponent("analysis.json"))
    print("{\"frames\":\(written)}")
}
do { try process() } catch { FileHandle.standardError.write(Data("\(error)\n".utf8)); exit(1) }
