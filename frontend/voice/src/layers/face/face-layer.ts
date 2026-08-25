import type { LayerLinkMessageBus } from "../../core/message-bus";
import { createEventEnvelope } from "../../core/message-bus";
import type { ProsodyState } from "../prosody/prosody-state";
import type { AffectState } from "../affect/affect-engine";

export type FaceExpression =
  | "neutral"
  | "listening"
  | "thinking"
  | "speaking"
  | "curious"
  | "warm"
  | "receptive"
  | "sleepy"
  | "surprised"
  | "amused"
  | "skeptical"
  | "focused"
  | "sympathetic"
  | "confused"
  | "fightingSleep"
  | "scanning"
  | "glitch"
  | "relieved"
  | "dizzy"
  | "deepProcessing"
  | "epiphany"
  | "dataScan"
  | "shy"
  | "circleLoading"
  | "questionMark"
  | "exclamation"
  | "pingPong"
  | "love"
  | "starstruck"
  | "dead"
  | "success"
  | "happy"
  | "squint"
  | "questionMorph"
  | "exclamationMorph"
  | "diamond"
  | "sparkle"
  | "lightning"
  | "infinity"
  | "teardrop"
  | "triangle"
  | "hexagon"
  | "shield"
  | "cloud"
  | "catEye";

export type FaceState = {
  readonly expression: FaceExpression;
  readonly theme: "geminiCore" | "deepCosmos" | "nebulaWarm" | "auroraGreen";
  readonly intensity: number;
  readonly phase: string;
  readonly isAiSpeaking: boolean;
  readonly isMicMuted: boolean;
  readonly userEmotionGuess?: string;
  readonly aiToneGuess?: string;
  readonly lastWordOrPhrase?: string;
};

export type FaceLayerOptions = {
  readonly bus: LayerLinkMessageBus;
  readonly nowMono?: () => number;
};

export class FaceLayer {
  private readonly bus: LayerLinkMessageBus;
  private readonly nowMono: () => number;
  private currentState: FaceState = {
    expression: "neutral",
    theme: "geminiCore",
    intensity: 0.5,
    phase: "idle",
    isAiSpeaking: false,
    isMicMuted: false,
  };
  private userTranscript = "";
  private aiTranscript = "";
  private prosodyState: ProsodyState | null = null;
  private affectState: AffectState | null = null;
  private unsubscriber: (() => void) | null = null;

  public constructor(options: FaceLayerOptions) {
    this.bus = options.bus;
    this.nowMono = options.nowMono ?? (() => performance.now());
    this.unsubscriber = this.bus.subscribe((envelope) => this.handleMessage(envelope), {});
  }

  public get state(): FaceState {
    return this.currentState;
  }

  public processUserTranscript(text: string): FaceState {
    this.userTranscript = text;
    return this.evaluateState();
  }

  public processAiTranscript(text: string): FaceState {
    this.aiTranscript = text;
    return this.evaluateState();
  }

  public processPhaseAndState(phase: string, isAiSpeaking: boolean, isMicMuted: boolean): FaceState {
    this.currentState = {
      ...this.currentState,
      phase,
      isAiSpeaking,
      isMicMuted,
    };
    return this.evaluateState();
  }

  public processProsodyState(prosody: ProsodyState): FaceState {
    this.prosodyState = prosody;
    return this.evaluateState();
  }

  public processAffectState(affect: AffectState): FaceState {
    this.affectState = affect;
    return this.evaluateState();
  }

  public evaluateState(): FaceState {
    let expression: FaceExpression = "neutral";
    let theme: FaceState["theme"] = "geminiCore";
    let intensity = 0.5;
    let aiToneGuess = "neutral";
    let userEmotionGuess = this.prosodyState?.emotionalGuess || "neutral";

    const phase = this.currentState.phase;
    const isAiSpeaking = this.currentState.isAiSpeaking;
    const isMicMuted = this.currentState.isMicMuted;
    const affectStance = this.affectState?.stance;
    const affectFeeling = this.affectState?.dominantFeeling;

    // 1. Connection or Error States
    if (phase === "error" || phase === "failed") {
      expression = "dead";
      theme = "nebulaWarm";
    } else if (phase === "connecting" || phase === "recovering") {
      expression = "circleLoading";
      theme = "deepCosmos";
    } else if (isMicMuted) {
      expression = "sleepy";
    } else if (phase === "thinking") {
      // Analyze user input to see what kind of thinking mode
      const userText = this.userTranscript.toLowerCase();
      if (userText.includes("why") || userText.includes("how") || userText.includes("what") || userText.includes("?")) {
        expression = "deepProcessing";
      } else if (userText.includes("math") || userText.includes("code") || userText.includes("analyze")) {
        expression = "dataScan";
      } else {
        expression = "thinking";
      }
      theme = "deepCosmos";
    } else if (isAiSpeaking || phase === "speaking") {
      // MindPal is speaking - prefer the affect controller, then classify text.
      if (affectStance === "gentle-concern") {
        expression = "sympathetic";
        theme = "deepCosmos";
        aiToneGuess = "empathetic";
      } else if (affectStance === "bright-playful" || affectStance === "confident-banter") {
        expression = "amused";
        theme = "geminiCore";
        aiToneGuess = "playful";
      } else if (affectStance === "calm-firm") {
        expression = "focused";
        theme = "nebulaWarm";
        aiToneGuess = "firm";
      } else if (affectStance === "curious-clarifying") {
        expression = "curious";
        theme = "geminiCore";
        aiToneGuess = "curious";
      } else if (affectStance === "warm-supportive") {
        expression = "warm";
        theme = "nebulaWarm";
        aiToneGuess = "warm";
      }
      // If affect did not select a specialized expression, classify the text.
      const aiText = this.aiTranscript.toLowerCase();
      const lastWords = aiText.slice(-150);

      if (expression !== "neutral" && aiToneGuess !== "neutral") {
        // Keep the affect-selected expression unless a stronger explicit text cue exists.
      } else if (lastWords.includes("love") || lastWords.includes("care") || lastWords.includes("adore") || lastWords.includes("favorite")) {
        expression = "love";
        theme = "nebulaWarm";
        aiToneGuess = "affectionate";
      } else if (lastWords.includes("aha") || lastWords.includes("eureka") || lastWords.includes("got it") || lastWords.includes("realize") || lastWords.includes("idea")) {
        expression = "epiphany";
        theme = "auroraGreen";
        aiToneGuess = "epiphany";
      } else if (lastWords.includes("amazing") || lastWords.includes("brilliant") || lastWords.includes("awesome") || lastWords.includes("fantastic") || lastWords.includes("wonderful")) {
        expression = "starstruck";
        theme = "nebulaWarm";
        aiToneGuess = "excited";
      } else if (lastWords.includes("congratulations") || lastWords.includes("success") || lastWords.includes("done") || lastWords.includes("completed") || lastWords.includes("perfect")) {
        expression = "success";
        theme = "auroraGreen";
        aiToneGuess = "triumphant";
      } else if (lastWords.includes("sorry") || lastWords.includes("understand how hard") || lastWords.includes("difficult") || lastWords.includes("feel for you") || lastWords.includes("sad")) {
        expression = "sympathetic";
        theme = "deepCosmos";
        aiToneGuess = "sympathetic";
      } else if (lastWords.includes("haha") || lastWords.includes("funny") || lastWords.includes("joke") || lastWords.includes("hilarious")) {
        expression = "amused";
        theme = "geminiCore";
        aiToneGuess = "amused";
      } else if (lastWords.includes("?") || lastWords.includes("what do you think") || lastWords.includes("curious")) {
        expression = "curious";
        theme = "geminiCore";
        aiToneGuess = "inquisitive";
      } else if (lastWords.includes("welcome") || lastWords.includes("hello") || lastWords.includes("glad") || lastWords.includes("nice to meet")) {
        expression = "warm";
        theme = "geminiCore";
        aiToneGuess = "warm";
      } else if (lastWords.includes("warning") || lastWords.includes("careful") || lastWords.includes("alert") || lastWords.includes("important")) {
        expression = "exclamationMorph";
        theme = "nebulaWarm";
        aiToneGuess = "cautionary";
      } else if (lastWords.includes("sparkle") || lastWords.includes("magic") || lastWords.includes("creative")) {
        expression = "sparkle";
        theme = "auroraGreen";
        aiToneGuess = "creative";
      } else {
        expression = "speaking";
        theme = "geminiCore";
      }
    } else if (phase === "listening" || phase === "attending") {
      // MindPal is listening - React to the user and the current affect stance.
      if (affectStance === "gentle-concern") expression = "sympathetic";
      else if (affectStance === "bright-playful" || affectStance === "confident-banter") expression = "amused";
      else if (affectStance === "curious-clarifying") expression = "curious";
      else if (affectStance === "calm-firm") expression = "focused";
      // MindPal is listening - React to what the user is saying & user prosody
      const userText = this.userTranscript.toLowerCase();
      const lastUserWords = userText.slice(-120);

      if (expression === "neutral") {
        if (this.prosodyState?.emotionalGuess === "excited" || lastUserWords.includes("wow") || lastUserWords.includes("unbelievable")) {
          expression = "surprised";
        } else if (this.prosodyState?.emotionalGuess === "frustrated" || lastUserWords.includes("stuck") || lastUserWords.includes("hard")) {
          expression = "sympathetic";
        } else if (lastUserWords.includes("?") || lastUserWords.includes("can you") || lastUserWords.includes("what")) {
          expression = "receptive";
        } else if (lastUserWords.includes("really?") || lastUserWords.includes("sure?")) {
          expression = "skeptical";
        } else {
          expression = "listening";
        }
      }
      theme = "geminiCore";
    }

    if (affectFeeling === "joy" || affectFeeling === "playfulness") intensity = Math.max(intensity, 0.65);
    if (affectFeeling === "concern" || affectFeeling === "empathy") intensity = Math.max(intensity, 0.6);

    const nextState: FaceState = {
      expression,
      theme,
      intensity,
      phase,
      isAiSpeaking,
      isMicMuted,
      userEmotionGuess,
      aiToneGuess,
      lastWordOrPhrase: isAiSpeaking ? this.aiTranscript.slice(-30) : this.userTranscript.slice(-30),
    };

    if (JSON.stringify(nextState) !== JSON.stringify(this.currentState)) {
      this.currentState = nextState;
      this.publishStateUpdate();
    }

    return this.currentState;
  }

  public dispose(): void {
    if (this.unsubscriber) {
      this.unsubscriber();
      this.unsubscriber = null;
    }
  }

  private handleMessage(envelope: { readonly messageType: string; readonly payload: unknown }): void {
    if (envelope.messageType === "prosody.state.updated") {
      const payload = envelope.payload as ProsodyState;
      if (payload && typeof payload.emotionalGuess === "string") {
        this.processProsodyState(payload);
      }
    } else if (envelope.messageType === "affect.state.updated") {
      const payload = envelope.payload as AffectState;
      if (payload && typeof payload.stance === "string" && payload.feelings) {
        this.processAffectState(payload);
      }
    } else if (envelope.messageType === "transcript.user.updated") {
      const payload = envelope.payload as { readonly text?: string };
      if (payload && typeof payload.text === "string") {
        this.processUserTranscript(payload.text);
      }
    } else if (envelope.messageType === "transcript.assistant.updated" || envelope.messageType === "transcript.ai.updated") {
      const payload = envelope.payload as { readonly text?: string };
      if (payload && typeof payload.text === "string") {
        this.processAiTranscript(payload.text);
      }
    }
  }

  private publishStateUpdate(): void {
    this.bus.publish(
      createEventEnvelope({
        messageId: `face-expression-${this.nowMono()}-${Math.random().toString(36).slice(2)}`,
        messageType: "face.expression.updated",
        sourceLayer: "face" as any,
        topic: "voice.face" as any,
        priority: "normal",
        timestampMono: this.nowMono(),
        ttlMs: 5000,
        identity: {
          sessionGeneration: "session-1",
          turnId: null,
          providerResponseId: null,
          playbackGeneration: null,
        },
        correlationId: "face-layer",
        payload: this.currentState,
      }),
    );
  }
}
