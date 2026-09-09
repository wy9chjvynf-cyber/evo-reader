import AVFoundation
import Capacitor
import Foundation

/// Small, EvoReader-specific Capacitor bridge over AVSpeechSynthesizer.
///
/// Exposes exactly what SpeechEngine (see src/lib/speechEngine.ts) needs —
/// availability, voice enumeration, speak, cancel — and forwards start/end
/// as plugin events. It intentionally does not attempt to be a general
/// text-to-speech plugin: no pause/resume (SpeechController never uses
/// native pause/resume — see SpeechEngineCapabilities.reliablePauseResume),
/// no highlighting, no Personal Voice authorization (deferred to a later
/// phase; see getVoices()).
@objc(EvoSpeechPlugin)
public class EvoSpeechPlugin: CAPPlugin, CAPBridgedPlugin, AVSpeechSynthesizerDelegate {
    public let identifier = "EvoSpeechPlugin"
    public let jsName = "EvoSpeech"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getVoices", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "speak", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise),
    ]

    // One long-lived synthesizer for the plugin's lifetime, per Apple's guidance —
    // recreating it per utterance is unnecessary and discards its delegate wiring.
    private let synthesizer = AVSpeechSynthesizer()

    public override func load() {
        synthesizer.delegate = self
        configureAudioSession()
    }

    /// .playback + the "Audio, AirPlay, and Picture in Picture" background mode
    /// (see Info.plist's UIBackgroundModes) is Apple's documented setup for apps
    /// that need spoken/audio playback to continue in the background. This only
    /// prepares the session for that; Now Playing / remote command controls are
    /// a later phase, not implemented here.
    private func configureAudioSession() {
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .spokenAudio, options: [])
            try session.setActive(true)
        } catch {
            // Fail soft: foreground narration still works even if the session
            // couldn't be configured (e.g. a simulator/environment quirk).
            NSLog("EvoSpeechPlugin: failed to configure AVAudioSession: \(error)")
        }
    }

    @objc func isAvailable(_ call: CAPPluginCall) {
        call.resolve(["available": true])
    }

    @objc func getVoices(_ call: CAPPluginCall) {
        // Personal Voices are only returned by speechVoices() once the app has
        // requested and been granted AVSpeechSynthesizer.requestPersonalVoiceAuthorization —
        // deliberately not done in this phase, so none will appear yet. The
        // .isPersonalVoice trait check below is enumeration-only, ready for
        // when that authorization is added.
        let voices = AVSpeechSynthesisVoice.speechVoices().map { voice -> [String: Any] in
            var dict: [String: Any] = [
                "identifier": voice.identifier,
                "name": voice.name,
                "language": voice.language,
                "quality": qualityName(voice.quality),
            ]
            if #available(iOS 17.0, *) {
                dict["personal"] = voice.voiceTraits.contains(.isPersonalVoice)
            }
            return dict
        }
        call.resolve(["voices": voices])
    }

    private func qualityName(_ quality: AVSpeechSynthesisVoiceQuality) -> String {
        switch quality {
        case .premium: return "premium"
        case .enhanced: return "enhanced"
        default: return "default"
        }
    }

    @objc func speak(_ call: CAPPluginCall) {
        guard let text = call.getString("text") else {
            call.reject("Missing 'text'")
            return
        }
        let rate = call.getFloat("rate") ?? AVSpeechUtteranceDefaultSpeechRate
        let voiceIdentifier = call.getString("voiceIdentifier")

        // One utterance at a time, matching SpeechController's sequential
        // one-chunk-at-a-time model — a new speak() always supersedes whatever
        // was in flight.
        synthesizer.stopSpeaking(at: .immediate)

        let utterance = AVSpeechUtterance(string: text)
        utterance.rate = rate
        if let voiceIdentifier = voiceIdentifier, let voice = AVSpeechSynthesisVoice(identifier: voiceIdentifier) {
            utterance.voice = voice
        }

        synthesizer.speak(utterance)
        call.resolve()
    }

    @objc func cancel(_ call: CAPPluginCall) {
        synthesizer.stopSpeaking(at: .immediate)
        call.resolve()
    }

    // MARK: AVSpeechSynthesizerDelegate
    //
    // No didCancel handling: a deliberate cancel() (pause/stop/skip) doesn't
    // need to report anything back — SpeechController already moved on
    // synchronously, and its own sequence counter ignores any stale event
    // that might still arrive, exactly like Web Speech's cancel().
    //
    // AVSpeechSynthesizerDelegate has no "failed" callback (on-device
    // synthesis doesn't fail the way network-backed Web Speech can), so
    // NativeIosSpeechEngine's onError only covers bridge/call-level failures.

    public func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
        notifyListeners("speechStart", data: [:])
    }

    public func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        notifyListeners("speechEnd", data: [:])
    }
}
