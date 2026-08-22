// frontend/js/voice/voice_face_visualizer.js — MindPal Voice Circle Face Visualizer
// Recreated and integrated from gradient_ai_voice_circle_face.html

const DEFAULT_STATE = Object.freeze({
  phase: "idle",
  isAiSpeaking: false,
  isMicMuted: false,
  isSpeakerMuted: false,
  interactionTag: "",
  backgroundTaskActive: false,
  error: false,
  faceExpression: "",
  faceTheme: "geminiCore",
  micLevel: 0,
  aiLevel: 0,
});

class SpringValue {
  constructor(val = 0, stiffness = 0.08, damping = 0.82) {
    this.current = val;
    this.target = val;
    this.velocity = 0;
    this.stiffness = stiffness;
    this.damping = damping;
  }

  update() {
    const force = (this.target - this.current) * this.stiffness;
    this.velocity = (this.velocity + force) * this.damping;
    this.current += this.velocity;
    return this.current;
  }

  set(val) {
    this.target = val;
  }

  snap(val) {
    this.current = val;
    this.target = val;
    this.velocity = 0;
  }
}

export const EMOTIONS = {
  neutral: {
    width: 24, height: 52, spacing: 72, angle: 0, radius: 12, offsetY: -36,
    leftHeightMult: 1.0, rightHeightMult: 1.0, leftAngleAdd: 0, rightAngleAdd: 0,
    name: "Neutral"
  },
  listening: {
    width: 26, height: 56, spacing: 76, angle: 0, radius: 13, offsetY: -34,
    leftHeightMult: 1.05, rightHeightMult: 1.05, leftAngleAdd: 0, rightAngleAdd: 0,
    name: "Attentive"
  },
  thinking: {
    width: 20, height: 42, spacing: 66, angle: 4, radius: 10, offsetY: -42,
    leftHeightMult: 0.95, rightHeightMult: 1.05, leftAngleAdd: 4, rightAngleAdd: 4,
    name: "Thinking"
  },
  speaking: {
    width: 24, height: 50, spacing: 72, angle: 0, radius: 12, offsetY: -36,
    leftHeightMult: 1.0, rightHeightMult: 1.0, leftAngleAdd: 0, rightAngleAdd: 0,
    name: "Speaking"
  },
  curious: {
    width: 25, height: 54, spacing: 74, angle: -5, radius: 12, offsetY: -38,
    leftHeightMult: 1.08, rightHeightMult: 0.92, leftAngleAdd: -4, rightAngleAdd: -2,
    name: "Curious"
  },
  warm: {
    width: 25, height: 40, spacing: 74, angle: -3, radius: 12, offsetY: -36,
    leftHeightMult: 0.85, rightHeightMult: 0.85, leftAngleAdd: -3, rightAngleAdd: 3,
    name: "Warm"
  },
  receptive: {
    width: 28, height: 58, spacing: 78, angle: 0, radius: 14, offsetY: -32,
    leftHeightMult: 1.1, rightHeightMult: 1.1, leftAngleAdd: 0, rightAngleAdd: 0,
    name: "Receptive"
  },
  sleepy: {
    width: 24, height: 16, spacing: 72, angle: 0, radius: 8, offsetY: -28,
    leftHeightMult: 0.4, rightHeightMult: 0.4, leftAngleAdd: 0, rightAngleAdd: 0,
    name: "Resting"
  },
  surprised: {
    width: 26, height: 68, spacing: 78, angle: 0, radius: 13, offsetY: -42,
    leftHeightMult: 1.0, rightHeightMult: 1.0, leftAngleAdd: 0, rightAngleAdd: 0,
    name: "Surprised"
  },
  amused: {
    width: 28, height: 28, spacing: 74, angle: -12, radius: 14, offsetY: -38,
    leftHeightMult: 0.8, rightHeightMult: 0.8, leftAngleAdd: 0, rightAngleAdd: 0,
    name: "Amused"
  },
  skeptical: {
    width: 22, height: 48, spacing: 70, angle: 0, radius: 11, offsetY: -36,
    leftHeightMult: 1.1, rightHeightMult: 0.55, leftAngleAdd: -2, rightAngleAdd: 5,
    name: "Skeptical"
  },
  focused: {
    width: 24, height: 38, spacing: 62, angle: 0, radius: 10, offsetY: -34,
    leftHeightMult: 1.0, rightHeightMult: 1.0, leftAngleAdd: 3, rightAngleAdd: -3,
    name: "Focused"
  },
  sympathetic: {
    width: 26, height: 46, spacing: 74, angle: -8, radius: 13, offsetY: -32,
    leftHeightMult: 0.9, rightHeightMult: 0.9, leftAngleAdd: 0, rightAngleAdd: 0,
    name: "Sympathetic"
  },
  confused: {
    width: 24, height: 48, spacing: 74, angle: 12, radius: 12, offsetY: -36,
    leftHeightMult: 0.9, rightHeightMult: 1.15, leftAngleAdd: 4, rightAngleAdd: -4,
    name: "Confused"
  },
  fightingSleep: {
    width: 24, height: 16, spacing: 72, angle: 0, radius: 8, offsetY: -24,
    leftHeightMult: 0.4, rightHeightMult: 0.4, leftAngleAdd: 0, rightAngleAdd: 0,
    name: "Fighting Sleep",
    behavior: (app) => {
      const cycle = () => {
        app.applyEmotionTargets({ height: 10, leftHeightMult: 0.25, rightHeightMult: 0.25, offsetY: -20, angle: 0 });
        app.behaviorTimers.push(setTimeout(() => {
          app.applyEmotionTargets({ height: 58, leftHeightMult: 1.1, rightHeightMult: 1.1, offsetY: -42, angle: -2 });
          app.behaviorTimers.push(setTimeout(cycle, 1500));
        }, 3500));
      };
      cycle();
    }
  },
  scanning: {
    width: 20, height: 40, spacing: 68, angle: 0, radius: 10, offsetY: -36,
    leftHeightMult: 1.0, rightHeightMult: 1.0, leftAngleAdd: 0, rightAngleAdd: 0,
    name: "Scanning",
    behavior: (app) => {
      app.overrideGaze = true;
      const cycle = () => {
        app.springs.gazeX.set(-20);
        app.springs.gazeY.set(0);
        app.behaviorTimers.push(setTimeout(() => {
          app.springs.gazeX.set(20);
          app.behaviorTimers.push(setTimeout(() => {
            app.springs.gazeX.set(0);
            app.behaviorTimers.push(setTimeout(cycle, 1000));
          }, 500));
        }, 500));
      };
      cycle();
    }
  },
  glitch: {
    width: 24, height: 50, spacing: 72, angle: 0, radius: 12, offsetY: -36,
    leftHeightMult: 1.0, rightHeightMult: 1.0, leftAngleAdd: 0, rightAngleAdd: 0,
    name: "Glitch",
    behavior: (app) => {
      const cycle = () => {
        app.applyEmotionTargets({
          leftHeightMult: 0.5 + Math.random() * 1.0,
          rightHeightMult: 0.5 + Math.random() * 1.0,
          leftAngleAdd: (Math.random() - 0.5) * 20,
          rightAngleAdd: (Math.random() - 0.5) * 20,
          spacing: 65 + Math.random() * 20,
          offsetY: -36 + (Math.random() - 0.5) * 10
        });
        app.behaviorTimers.push(setTimeout(cycle, 180));
      };
      cycle();
    }
  },
  relieved: {
    width: 26, height: 20, spacing: 74, angle: -8, radius: 12, offsetY: -46,
    leftHeightMult: 0.9, rightHeightMult: 0.9, leftAngleAdd: 0, rightAngleAdd: 0,
    name: "Relieved",
    behavior: (app) => {
      app.behaviorTimers.push(setTimeout(() => {
        app.applyEmotionTargets({
          height: 44, angle: 4, offsetY: -32,
          leftHeightMult: 0.85, rightHeightMult: 0.85
        });
      }, 800));
    }
  },
  dizzy: {
    width: 24, height: 42, spacing: 72, angle: 0, radius: 11, offsetY: -36,
    leftHeightMult: 1.0, rightHeightMult: 1.0, leftAngleAdd: 0, rightAngleAdd: 0,
    name: "Dizzy",
    behavior: (app) => {
      let tick = 0;
      const cycle = () => {
        tick += 0.4;
        app.applyEmotionTargets({
          leftAngleAdd: Math.sin(tick) * 25,
          rightAngleAdd: Math.cos(tick) * 25,
          offsetY: -36 + Math.sin(tick * 1.5) * 12,
          spacing: 72 + Math.cos(tick) * 8
        });
        app.behaviorTimers.push(setTimeout(cycle, 100));
      };
      cycle();
    }
  },
  deepProcessing: {
    width: 22, height: 38, spacing: 64, angle: 0, radius: 11, offsetY: -38,
    leftHeightMult: 0.9, rightHeightMult: 0.9, leftAngleAdd: 3, rightAngleAdd: -3,
    name: "Deep Processing",
    behavior: (app) => {
      let tick = 0;
      const cycle = () => {
        tick += 0.2;
        app.applyEmotionTargets({
          leftHeightMult: 0.85 + Math.sin(tick) * 0.15,
          rightHeightMult: 0.85 + Math.cos(tick * 0.8) * 0.15,
          spacing: 64 + Math.sin(tick * 0.5) * 4,
          offsetY: -38 + Math.cos(tick * 1.2) * 2
        });
        app.behaviorTimers.push(setTimeout(cycle, 50));
      };
      cycle();
    }
  },
  epiphany: {
    width: 20, height: 42, spacing: 66, angle: 4, radius: 10, offsetY: -42,
    leftHeightMult: 0.95, rightHeightMult: 1.05, leftAngleAdd: 4, rightAngleAdd: 4,
    name: "Epiphany",
    behavior: (app) => {
      app.behaviorTimers.push(setTimeout(() => {
        app.applyEmotionTargets({
          height: 62, width: 26, spacing: 76, angle: 0, offsetY: -48,
          leftHeightMult: 1.1, rightHeightMult: 1.1, leftAngleAdd: 0, rightAngleAdd: 0
        });
        app.behaviorTimers.push(setTimeout(() => {
          app.applyEmotionTargets({
            height: 40, width: 25, spacing: 74, angle: -5, offsetY: -36,
            leftHeightMult: 0.85, rightHeightMult: 0.85, leftAngleAdd: -3, rightAngleAdd: 3
          });
        }, 1200));
      }, 1800));
    }
  },
  dataScan: {
    width: 20, height: 26, spacing: 68, angle: 0, radius: 10, offsetY: -36,
    leftHeightMult: 1.0, rightHeightMult: 1.0, leftAngleAdd: 0, rightAngleAdd: 0,
    name: "Data Scan",
    behavior: (app) => {
      app.overrideGaze = true;
      let row = 0;
      let dir = 1;
      const cycle = () => {
        app.springs.gazeY.set(row === 0 ? -4 : 8);
        app.springs.gazeX.set(-18 * dir);
        app.behaviorTimers.push(setTimeout(() => {
          app.springs.gazeX.set(0);
          app.behaviorTimers.push(setTimeout(() => {
            app.springs.gazeX.set(18 * dir);
            app.behaviorTimers.push(setTimeout(() => {
              dir *= -1;
              row = row === 0 ? 1 : 0;
              app.behaviorTimers.push(setTimeout(cycle, 300));
            }, 250));
          }, 300));
        }, 300));
      };
      cycle();
    }
  },
  shy: {
    width: 22, height: 34, spacing: 68, angle: 0, radius: 11, offsetY: -30,
    leftHeightMult: 0.8, rightHeightMult: 0.8, leftAngleAdd: 5, rightAngleAdd: -5,
    name: "Shy",
    behavior: (app) => {
      app.overrideGaze = true;
      const cycle = () => {
        app.springs.gazeX.set(-15);
        app.springs.gazeY.set(12);
        app.behaviorTimers.push(setTimeout(() => {
          app.springs.gazeX.set(-8);
          app.springs.gazeY.set(4);
          app.behaviorTimers.push(setTimeout(cycle, 1200));
        }, 2500));
      };
      cycle();
    }
  },
  circleLoading: {
    width: 18, height: 18, spacing: 50, angle: 0, radius: 9, offsetY: -36,
    leftHeightMult: 1.0, rightHeightMult: 1.0, leftAngleAdd: 0, rightAngleAdd: 0,
    name: "Loading",
    behavior: (app) => {
      app.overrideGaze = true;
      let tick = 0;
      const cycle = () => {
        tick += 0.25;
        app.springs.gazeX.set(Math.cos(tick) * 20);
        app.springs.gazeY.set(Math.sin(tick) * 20);
        app.applyEmotionTargets({
          spacing: 50 + Math.sin(tick * 0.5) * 15,
          leftHeightMult: 0.6 + Math.sin(tick) * 0.6,
          rightHeightMult: 0.6 + Math.cos(tick) * 0.6,
          angle: Math.sin(tick * 0.2) * 20
        });
        app.behaviorTimers.push(setTimeout(cycle, 50));
      };
      cycle();
    }
  },
  questionMark: {
    width: 22, height: 42, spacing: 68, angle: 0, radius: 11, offsetY: -36,
    leftHeightMult: 1.0, rightHeightMult: 1.0, leftAngleAdd: 0, rightAngleAdd: 0,
    name: "Question",
    behavior: (app) => {
      app.overrideGaze = true;
      const cycle = () => {
        app.applyEmotionTargets({ angle: 12, leftHeightMult: 1.1, rightHeightMult: 0.7, leftAngleAdd: -5, rightAngleAdd: 5 });
        app.springs.gazeX.set(0); app.springs.gazeY.set(-20);
        app.behaviorTimers.push(setTimeout(() => {
          app.springs.gazeX.set(18); app.springs.gazeY.set(-10);
          app.behaviorTimers.push(setTimeout(() => {
            app.springs.gazeX.set(5); app.springs.gazeY.set(5);
            app.behaviorTimers.push(setTimeout(() => {
              app.springs.gazeX.set(0); app.springs.gazeY.set(25);
              app.applyEmotionTargets({ height: 12, spacing: 45 });
              app.behaviorTimers.push(setTimeout(() => {
                app.applyEmotionTargets({ height: 42, spacing: 68 });
                app.behaviorTimers.push(setTimeout(cycle, 1500));
              }, 500));
            }, 400));
          }, 400));
        }, 400));
      };
      cycle();
    }
  },
  exclamation: {
    width: 20, height: 30, spacing: 68, angle: 0, radius: 10, offsetY: -30,
    leftHeightMult: 1.0, rightHeightMult: 1.0, leftAngleAdd: 0, rightAngleAdd: 0,
    name: "Alert !",
    behavior: (app) => {
      app.overrideGaze = true;
      const cycle = () => {
        app.applyEmotionTargets({ width: 22, height: 20, spacing: 70, offsetY: -25, angle: 0, leftHeightMult: 1, rightHeightMult: 1 });
        app.springs.gazeY.set(5);
        app.springs.gazeX.set(0);
        app.behaviorTimers.push(setTimeout(() => {
          app.applyEmotionTargets({ width: 12, height: 75, spacing: 55, offsetY: -48 });
          app.springs.gazeY.set(-15);
          app.behaviorTimers.push(setTimeout(() => { app.springs.gazeX.set(-6); }, 50));
          app.behaviorTimers.push(setTimeout(() => { app.springs.gazeX.set(6); }, 100));
          app.behaviorTimers.push(setTimeout(() => { app.springs.gazeX.set(0); }, 150));
          app.behaviorTimers.push(setTimeout(cycle, 2200));
        }, 1200));
      };
      cycle();
    }
  },
  pingPong: {
    width: 22, height: 38, spacing: 68, angle: 0, radius: 11, offsetY: -36,
    leftHeightMult: 1.0, rightHeightMult: 1.0, leftAngleAdd: 0, rightAngleAdd: 0,
    name: "Ping Pong",
    behavior: (app) => {
      app.overrideGaze = true;
      let isLeft = true;
      const cycle = () => {
        const dir = isLeft ? -1 : 1;
        app.springs.gazeX.set(dir * 25);
        app.springs.gazeY.set(0);
        app.applyEmotionTargets({
          leftHeightMult: isLeft ? 1.35 : 0.75,
          rightHeightMult: isLeft ? 0.75 : 1.35,
          leftAngleAdd: isLeft ? -12 : 5,
          rightAngleAdd: isLeft ? -5 : 12
        });
        isLeft = !isLeft;
        app.behaviorTimers.push(setTimeout(cycle, 600));
      };
      cycle();
    }
  },
  love: {
    width: 32, height: 32, spacing: 72, angle: 0, radius: 12, offsetY: -36,
    leftHeightMult: 1.0, rightHeightMult: 1.0, leftAngleAdd: -8, rightAngleAdd: 8,
    shape: 'heart', name: "Love"
  },
  starstruck: {
    width: 34, height: 34, spacing: 74, angle: 0, radius: 12, offsetY: -38,
    leftHeightMult: 1.0, rightHeightMult: 1.0, leftAngleAdd: 0, rightAngleAdd: 0,
    shape: 'star', name: "Starstruck",
    behavior: (app) => {
      let tick = 0;
      const cycle = () => {
        tick += 0.05;
        app.applyEmotionTargets({ leftAngleAdd: tick * 50, rightAngleAdd: -tick * 50 });
        app.behaviorTimers.push(setTimeout(cycle, 50));
      };
      cycle();
    }
  },
  dead: {
    width: 28, height: 28, spacing: 72, angle: 0, radius: 12, offsetY: -36,
    leftHeightMult: 1.0, rightHeightMult: 1.0, leftAngleAdd: 0, rightAngleAdd: 0,
    shape: 'cross', name: "Error"
  },
  success: {
    width: 32, height: 32, spacing: 72, angle: 0, radius: 12, offsetY: -36,
    leftHeightMult: 1.0, rightHeightMult: 1.0, leftAngleAdd: 0, rightAngleAdd: 0,
    shape: 'check', name: "Success"
  },
  happy: {
    width: 32, height: 20, spacing: 72, angle: 0, radius: 12, offsetY: -36,
    leftHeightMult: 1.0, rightHeightMult: 1.0, leftAngleAdd: 0, rightAngleAdd: 0,
    shape: 'crescent', name: "Happy"
  },
  squint: {
    width: 28, height: 28, spacing: 74, angle: 0, radius: 12, offsetY: -36,
    leftHeightMult: 1.0, rightHeightMult: 1.0, leftAngleAdd: 0, rightAngleAdd: 0,
    shape: 'squint', name: "Squint"
  },
  questionMorph: {
    width: 28, height: 42, spacing: 72, angle: 0, radius: 12, offsetY: -36,
    leftHeightMult: 1.0, rightHeightMult: 1.0, leftAngleAdd: 0, rightAngleAdd: 0,
    shape: 'question', name: "Question"
  },
  exclamationMorph: {
    width: 18, height: 48, spacing: 70, angle: 0, radius: 12, offsetY: -36,
    leftHeightMult: 1.0, rightHeightMult: 1.0, leftAngleAdd: 0, rightAngleAdd: 0,
    shape: 'exclamation', name: "Alert!"
  },
  diamond: {
    width: 32, height: 38, spacing: 72, angle: 0, radius: 12, offsetY: -36,
    leftHeightMult: 1.0, rightHeightMult: 1.0, leftAngleAdd: 0, rightAngleAdd: 0,
    shape: 'diamond', name: "Diamond"
  },
  sparkle: {
    width: 34, height: 34, spacing: 74, angle: 0, radius: 12, offsetY: -36,
    leftHeightMult: 1.0, rightHeightMult: 1.0, leftAngleAdd: 0, rightAngleAdd: 0,
    shape: 'sparkle', name: "Sparkle"
  },
  lightning: {
    width: 28, height: 44, spacing: 72, angle: 0, radius: 12, offsetY: -36,
    leftHeightMult: 1.0, rightHeightMult: 1.0, leftAngleAdd: -4, rightAngleAdd: 4,
    shape: 'lightning', name: "Lightning"
  },
  infinity: {
    width: 38, height: 26, spacing: 74, angle: 0, radius: 12, offsetY: -36,
    leftHeightMult: 1.0, rightHeightMult: 1.0, leftAngleAdd: 0, rightAngleAdd: 0,
    shape: 'infinity', name: "Infinity"
  },
  teardrop: {
    width: 28, height: 38, spacing: 72, angle: 0, radius: 12, offsetY: -34,
    leftHeightMult: 1.0, rightHeightMult: 1.0, leftAngleAdd: -6, rightAngleAdd: 6,
    shape: 'teardrop', name: "Teardrop"
  },
  triangle: {
    width: 34, height: 36, spacing: 72, angle: 0, radius: 12, offsetY: -36,
    leftHeightMult: 1.0, rightHeightMult: 1.0, leftAngleAdd: 0, rightAngleAdd: 0,
    shape: 'triangle', name: "Triangle"
  },
  hexagon: {
    width: 32, height: 36, spacing: 74, angle: 0, radius: 12, offsetY: -36,
    leftHeightMult: 1.0, rightHeightMult: 1.0, leftAngleAdd: 0, rightAngleAdd: 0,
    shape: 'hexagon', name: "Cyber Hex"
  },
  shield: {
    width: 32, height: 38, spacing: 72, angle: 0, radius: 12, offsetY: -36,
    leftHeightMult: 1.0, rightHeightMult: 1.0, leftAngleAdd: 0, rightAngleAdd: 0,
    shape: 'shield', name: "Shield"
  },
  cloud: {
    width: 36, height: 28, spacing: 74, angle: 0, radius: 12, offsetY: -36,
    leftHeightMult: 1.0, rightHeightMult: 1.0, leftAngleAdd: 0, rightAngleAdd: 0,
    shape: 'cloud', name: "Cloud"
  },
  catEye: {
    width: 38, height: 18, spacing: 76, angle: 8, radius: 12, offsetY: -36,
    leftHeightMult: 1.0, rightHeightMult: 1.0, leftAngleAdd: 6, rightAngleAdd: -6,
    shape: 'catEye', name: "Cat Eye"
  }
};

export const THEMES = {
  geminiCore: {
    stops: [
      { r: 66, g: 133, b: 244 },
      { r: 154, g: 109, b: 255 },
      { r: 255, g: 112, b: 168 }
    ],
    bgGlow: 'rgba(66, 133, 244, 0.35)',
    rim: 'rgba(255, 255, 255, 0.3)'
  },
  deepCosmos: {
    stops: [
      { r: 56, g: 189, b: 248 },
      { r: 99, g: 102, b: 241 },
      { r: 168, g: 85, b: 247 }
    ],
    bgGlow: 'rgba(56, 189, 248, 0.35)',
    rim: 'rgba(255, 255, 255, 0.3)'
  },
  nebulaWarm: {
    stops: [
      { r: 168, g: 85, b: 247 },
      { r: 244, g: 114, b: 182 },
      { r: 251, g: 146, b: 60 }
    ],
    bgGlow: 'rgba(244, 114, 182, 0.35)',
    rim: 'rgba(255, 255, 255, 0.3)'
  },
  auroraGreen: {
    stops: [
      { r: 52, g: 211, b: 153 },
      { r: 56, g: 189, b: 248 },
      { r: 129, g: 140, b: 248 }
    ],
    bgGlow: 'rgba(52, 211, 153, 0.35)',
    rim: 'rgba(255, 255, 255, 0.3)'
  }
};

const MorphUtils = {
  resamplePolygon: function(vertices, numPoints = 60) {
    let totalLength = 0;
    const segments = [];
    for (let i = 0; i < vertices.length; i++) {
      const p1 = vertices[i];
      const p2 = vertices[(i + 1) % vertices.length];
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const len = Math.hypot(dx, dy);
      segments.push({ p1, p2, len, dx, dy });
      totalLength += len;
    }

    const result = [];
    let currentSeg = 0;
    let accumulated = 0;

    for (let i = 0; i < numPoints; i++) {
      const targetDist = (i / numPoints) * totalLength;
      if (i === numPoints - 1) {
        result.push({x: vertices[0].x, y: vertices[0].y});
        continue;
      }
      while (currentSeg < segments.length && accumulated + segments[currentSeg].len < targetDist - 0.0001) {
        accumulated += segments[currentSeg].len;
        currentSeg++;
      }
      if (currentSeg >= segments.length) currentSeg = segments.length - 1;
      const seg = segments[currentSeg];
      const excess = targetDist - accumulated;
      const t = seg.len === 0 ? 0 : excess / seg.len;
      result.push({ x: seg.p1.x + seg.dx * t, y: seg.p1.y + seg.dy * t });
    }
    return result;
  },
  alignPhase: function(pts) {
    let minIdx = 0;
    let minY = Infinity;
    pts.forEach((p, i) => { if (p.y < minY) { minY = p.y; minIdx = i; } });
    return [...pts.slice(minIdx), ...pts.slice(0, minIdx)];
  }
};

const EyeShapes = {
  capsule: (w, h, radius) => {
    const r = Math.max(0.1, Math.min(radius, w/2, h/2));
    const pts = [];
    const steps = 15;
    for(let i=0; i<steps; i++) {
      const a = -Math.PI/2 + (i/(steps-1)) * (Math.PI/2);
      pts.push({ x: w/2 - r + Math.cos(a)*r, y: -h/2 + r + Math.sin(a)*r });
    }
    for(let i=0; i<steps; i++) {
      const a = 0 + (i/(steps-1)) * (Math.PI/2);
      pts.push({ x: w/2 - r + Math.cos(a)*r, y: h/2 - r + Math.sin(a)*r });
    }
    for(let i=0; i<steps; i++) {
      const a = Math.PI/2 + (i/(steps-1)) * (Math.PI/2);
      pts.push({ x: -w/2 + r + Math.cos(a)*r, y: h/2 - r + Math.sin(a)*r });
    }
    for(let i=0; i<steps; i++) {
      const a = Math.PI + (i/(steps-1)) * (Math.PI/2);
      pts.push({ x: -w/2 + r + Math.cos(a)*r, y: -h/2 + r + Math.sin(a)*r });
    }
    return MorphUtils.alignPhase(pts);
  },
  star: (w, h) => {
    const pts = [];
    const size = Math.max(w, h) * 1.3;
    for(let i=0; i<10; i++) {
      const r = i%2 === 0 ? size/2 : size/4;
      const a = (i/10)*Math.PI*2 - Math.PI/2;
      pts.push({x: Math.cos(a)*r, y: Math.sin(a)*r});
    }
    return MorphUtils.alignPhase(MorphUtils.resamplePolygon(pts, 60));
  },
  cross: (w, h) => {
    const size = Math.max(w, h);
    const t = size * 0.18;
    const hw = size / 2;
    const pts = [
      {x: t, y: -hw}, {x: hw, y: -t}, {x: t, y: 0},
      {x: hw, y: t}, {x: t, y: hw}, {x: 0, y: t},
      {x: -t, y: hw}, {x: -hw, y: t}, {x: -t, y: 0},
      {x: -hw, y: -t}, {x: -t, y: -hw}, {x: 0, y: -t}
    ];
    return MorphUtils.alignPhase(MorphUtils.resamplePolygon(pts, 60));
  },
  heart: (w, h) => {
    const pts = [];
    const size = Math.max(w, h) * 0.45;
    for(let i=0; i<60; i++) {
      const t = (i/60) * Math.PI * 2;
      const x = 16 * Math.pow(Math.sin(t), 3);
      const y = -(13*Math.cos(t) - 5*Math.cos(2*t) - 2*Math.cos(3*t) - Math.cos(4*t));
      pts.push({ x: (x/16) * (size*1.3), y: (y/16) * (size*1.3) - size*0.1 });
    }
    return MorphUtils.alignPhase(pts);
  },
  crescent: (w, h) => {
    const pts = [];
    for(let i=0; i<30; i++) {
      const a = Math.PI + (i/29)*Math.PI;
      pts.push({ x: Math.cos(a)*w/2, y: Math.sin(a)*h/2 });
    }
    for(let i=0; i<30; i++) {
      const a = 2*Math.PI - (i/29)*Math.PI;
      pts.push({ x: Math.cos(a)*w/2 * 0.6, y: Math.sin(a)*h/2 * 0.6 - h*0.15 });
    }
    return MorphUtils.alignPhase(pts);
  },
  squint: (w, h, r, isRight) => {
    const dir = isRight ? -1 : 1;
    const hw = w/2, hh = h/2;
    const pts = [
      {x: -hw * dir, y: -hh}, {x: hw * dir, y: 0}, {x: -hw * dir, y: hh},
      {x: (-hw + w*0.3) * dir, y: hh*0.6}, {x: (hw - w*0.3) * dir, y: 0}, {x: (-hw + w*0.3) * dir, y: -hh*0.6}
    ];
    return MorphUtils.alignPhase(MorphUtils.resamplePolygon(pts, 60));
  },
  check: (w, h) => {
    const size = Math.max(w, h) * 1.2;
    const pts = [
      {x: -0.3, y: 0.1}, {x: -0.1, y: 0.3}, {x: 0.4, y: -0.4},
      {x: 0.25, y: -0.5}, {x: -0.1, y: 0.05}, {x: -0.2, y: -0.05}
    ].map(p => ({ x: p.x * size, y: p.y * size }));
    return MorphUtils.alignPhase(MorphUtils.resamplePolygon(pts, 60));
  },
  exclamation: (w, h) => {
    const size = Math.max(w, h);
    const pts = [
      {x: -0.15, y: -0.5}, {x: 0.15, y: -0.5}, {x: 0.06, y: 0.1}, {x: -0.06, y: 0.1},
      {x: -0.01, y: 0.1}, {x: -0.01, y: 0.3},
      {x: 0.12, y: 0.3}, {x: 0.12, y: 0.5}, {x: -0.12, y: 0.5}, {x: -0.12, y: 0.3},
      {x: 0.01, y: 0.3}, {x: 0.01, y: -0.15}
    ].map(p => ({ x: p.x * size, y: p.y * size }));
    return MorphUtils.alignPhase(MorphUtils.resamplePolygon(pts, 60));
  },
  question: (w, h) => {
    const size = Math.max(w, h) * 1.1;
    const pts = [
      {x: -0.25, y: -0.2}, {x: -0.25, y: -0.4}, {x: 0.25, y: -0.5}, {x: 0.35, y: -0.1},
      {x: 0.1, y: 0.15}, {x: 0.1, y: 0.25}, {x: -0.1, y: 0.25}, {x: -0.1, y: 0.1},
      {x: 0.15, y: -0.1}, {x: 0.05, y: -0.25}, {x: -0.1, y: -0.15},
      {x: -0.01, y: -0.15}, {x: -0.01, y: 0.35},
      {x: 0.1, y: 0.35}, {x: 0.1, y: 0.5}, {x: -0.1, y: 0.5}, {x: -0.1, y: 0.35},
      {x: 0.01, y: 0.35}, {x: 0.01, y: -0.15}
    ].map(p => ({ x: p.x * size, y: p.y * size }));
    return MorphUtils.alignPhase(MorphUtils.resamplePolygon(pts, 60));
  },
  diamond: (w, h) => {
    const hw = w / 2, hh = h / 2;
    const pts = [{x: 0, y: -hh}, {x: hw, y: 0}, {x: 0, y: hh}, {x: -hw, y: 0}];
    return MorphUtils.alignPhase(MorphUtils.resamplePolygon(pts, 60));
  },
  triangle: (w, h) => {
    const hw = w / 2, hh = h / 2;
    const pts = [{x: 0, y: -hh}, {x: hw, y: hh}, {x: -hw, y: hh}];
    return MorphUtils.alignPhase(MorphUtils.resamplePolygon(pts, 60));
  },
  sparkle: (w, h) => {
    const pts = [];
    const size = Math.max(w, h) * 0.65;
    for (let i = 0; i < 8; i++) {
      const r = i % 2 === 0 ? size : size * 0.24;
      const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
      pts.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
    }
    return MorphUtils.alignPhase(MorphUtils.resamplePolygon(pts, 60));
  },
  lightning: (w, h) => {
    const size = Math.max(w, h);
    const pts = [
      {x: 0.1, y: -0.5}, {x: -0.3, y: -0.05}, {x: -0.05, y: -0.05},
      {x: -0.2, y: 0.5}, {x: 0.2, y: 0.05}, {x: -0.05, y: 0.05}
    ].map(p => ({ x: p.x * size, y: p.y * size }));
    return MorphUtils.alignPhase(MorphUtils.resamplePolygon(pts, 60));
  },
  infinity: (w, h) => {
    const pts = [];
    const scaleX = w * 0.55;
    const scaleY = h * 0.45;
    for (let i = 0; i < 60; i++) {
      const t = (i / 60) * Math.PI * 2;
      const denom = 1 + Math.pow(Math.cos(t), 2);
      pts.push({
        x: (scaleX * Math.sin(t)) / denom,
        y: (scaleY * Math.sin(t) * Math.cos(t)) / denom
      });
    }
    return MorphUtils.alignPhase(pts);
  },
  teardrop: (w, h) => {
    const pts = [];
    for (let i = 0; i < 60; i++) {
      const t = (i / 60) * Math.PI * 2;
      const x = (w * 0.45) * Math.sin(t / 2) * Math.sin(t);
      const y = -(h * 0.5) * Math.cos(t);
      pts.push({ x, y });
    }
    return MorphUtils.alignPhase(pts);
  },
  hexagon: (w, h) => {
    const pts = [];
    const hw = w / 2, hh = h / 2;
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 - Math.PI / 6;
      pts.push({ x: Math.cos(a) * hw, y: Math.sin(a) * hh });
    }
    return MorphUtils.alignPhase(MorphUtils.resamplePolygon(pts, 60));
  },
  shield: (w, h) => {
    const hw = w / 2, hh = h / 2;
    const pts = [
      {x: -hw, y: -hh}, {x: hw, y: -hh}, {x: hw, y: -hh * 0.2},
      {x: 0, y: hh}, {x: -hw, y: -hh * 0.2}
    ];
    return MorphUtils.alignPhase(MorphUtils.resamplePolygon(pts, 60));
  },
  cloud: (w, h) => {
    const pts = [];
    const rx = w / 2, ry = h / 2;
    for (let i = 0; i < 60; i++) {
      const a = (i / 60) * Math.PI * 2;
      const rMult = 1 + 0.22 * Math.sin(a * 4) + 0.12 * Math.cos(a * 2);
      pts.push({ x: Math.cos(a) * rx * rMult * 0.8, y: Math.sin(a) * ry * rMult * 0.8 });
    }
    return MorphUtils.alignPhase(pts);
  },
  catEye: (w, h) => {
    const pts = [];
    const hw = w / 2, hh = h / 2;
    for (let i = 0; i < 30; i++) {
      const t = i / 29;
      pts.push({ x: -hw + t * w, y: -Math.sin(t * Math.PI) * hh });
    }
    for (let i = 0; i < 30; i++) {
      const t = i / 29;
      pts.push({ x: hw - t * w, y: Math.sin(t * Math.PI) * hh });
    }
    return MorphUtils.alignPhase(MorphUtils.resamplePolygon(pts, 60));
  }
};

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : 0));
}

export const EXPRESSION_LABELS = {
  neutral: "Ready",
  listening: "Listening",
  speaking: "MindPal is speaking",
  thinking: "Thinking",
  backchannel: "Responding briefly",
  muted: "Microphone muted",
  connecting: "Connecting",
  error: "Voice connection error",
};

export function deriveVoiceFaceState({
  phase = "idle",
  isAiSpeaking = false,
  isMicMuted = false,
  isSpeakerMuted = false,
  interactionTag = "",
  backgroundTaskActive = false,
  error = false,
  faceExpression = "",
  faceTheme = "geminiCore",
  micLevel = 0,
} = {}) {
  const normalizedPhase = String(phase || "idle").toLowerCase();
  let expression = faceExpression;

  if (!expression) {
    if (error || ["error", "failed", "provider-error"].includes(normalizedPhase)) {
      expression = "error";
    } else if (String(interactionTag).includes("backchannel") || String(interactionTag).includes("cue")) {
      expression = "backchannel";
    } else if (Boolean(isAiSpeaking) || normalizedPhase === "speaking") {
      expression = "speaking";
    } else if (backgroundTaskActive || ["thinking", "preparing", "interrupting", "holding"].includes(normalizedPhase)) {
      expression = "thinking";
    } else if (["connecting", "recovering"].includes(normalizedPhase)) {
      expression = "connecting";
    } else if (isMicMuted) {
      expression = "muted";
    } else if (["listening", "attending"].includes(normalizedPhase)) {
      expression = clamp(micLevel) >= 0.065 ? "listening" : "neutral";
    } else {
      expression = "neutral";
    }
  }

  const emotionInfo = EMOTIONS[expression] || EMOTIONS.neutral;
  const label = EXPRESSION_LABELS[expression] || emotionInfo.name || "MindPal Voice";

  return {
    expression,
    theme: faceTheme,
    phase: normalizedPhase,
    isAiSpeaking: Boolean(isAiSpeaking),
    isMicMuted: Boolean(isMicMuted),
    isSpeakerMuted: Boolean(isSpeakerMuted),
    label,
  };
}

class AIFaceCanvas {
  constructor(canvas, labelElement) {
    this.canvas = canvas;
    this.ctx = canvas?.getContext?.('2d') || null;
    this.labelElement = labelElement || null;
    this.container = canvas?.parentElement || null;

    // Dimensions
    this.width = 0;
    this.height = 0;
    this.centerX = 0;
    this.centerY = 0;
    this.orbRadius = 180;
    this.running = false;
    this.frameId = null;

    // Mouse Tracking
    this.mouseX = typeof window !== 'undefined' ? window.innerWidth / 2 : 400;
    this.mouseY = typeof window !== 'undefined' ? window.innerHeight / 2 : 300;
    this.mouseTrackingEnabled = true;

    // Spring Physics Engine Instances for Eyes & Face
    this.springs = {
      width: new SpringValue(24),
      height: new SpringValue(52),
      spacing: new SpringValue(72),
      angle: new SpringValue(0),
      radius: new SpringValue(12),
      offsetY: new SpringValue(-36),
      leftHeightMult: new SpringValue(1.0),
      rightHeightMult: new SpringValue(1.0),
      leftAngleAdd: new SpringValue(0),
      rightAngleAdd: new SpringValue(0),
      gazeX: new SpringValue(0, 0.05, 0.85),
      gazeY: new SpringValue(0, 0.05, 0.85),
      orbPulse: new SpringValue(0, 0.09, 0.8)
    };

    // Organic Fluid Mesh Animation Controls
    this.time = 0;
    this.meshRotation = 0;

    // Blinking Logic
    this.blinkValue = 1.0;
    this.isBlinking = false;
    this.autoBlinkEnabled = true;

    // Active States
    this.currentEmotion = 'neutral';
    this.currentTheme = 'geminiCore';
    this.state = { ...DEFAULT_STATE };

    // Behavior Engine
    this.behaviorTimers = [];
    this.overrideGaze = false;

    // Soft Background Waves
    this.ripples = [];

    // Vertex Physics State Tracking
    this.leftShapeType = 'capsule';
    this.rightShapeType = 'capsule';
    this.leftPts = Array.from({length: 60}, () => ({x:0, y:0, vx:0, vy:0}));
    this.rightPts = Array.from({length: 60}, () => ({x:0, y:0, vx:0, vy:0}));

    const initPts = EyeShapes.capsule(24, 52, 12);
    for(let i=0; i<60; i++) {
      this.leftPts[i].x = initPts[i].x; this.leftPts[i].y = initPts[i].y;
      this.rightPts[i].x = initPts[i].x; this.rightPts[i].y = initPts[i].y;
    }

    this.onWindowResize = () => this.resize();
    this.onMouseMove = (e) => {
      this.mouseX = e.clientX;
      this.mouseY = e.clientY;
    };

    if (this.canvas) {
      this.resize();
    }
  }

  start() {
    if (!this.canvas || !this.ctx) return false;
    this.running = true;
    this.resize();

    if (typeof window !== 'undefined') {
      window.addEventListener('resize', this.onWindowResize, { passive: true });
      window.addEventListener('mousemove', this.onMouseMove, { passive: true });
    }

    this.scheduleNextBlink();
    this.animate();
    return true;
  }

  stop() {
    this.running = false;
    if (this.frameId !== null) cancelAnimationFrame(this.frameId);
    this.frameId = null;

    if (typeof window !== 'undefined') {
      window.removeEventListener('resize', this.onWindowResize);
      window.removeEventListener('mousemove', this.onMouseMove);
    }
    this.clearBehaviors();
  }

  dispose() {
    this.stop();
    this.canvas = null;
    this.ctx = null;
    this.container = null;
    this.labelElement = null;
  }

  resize() {
    if (!this.canvas || !this.ctx) return;
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const rect = this.canvas.getBoundingClientRect?.() || { width: 400, height: 400 };
    this.width = Math.max(1, rect.width || this.canvas.clientWidth || 400);
    this.height = Math.max(1, rect.height || this.canvas.clientHeight || 400);

    const targetWidth = Math.round(this.width * dpr);
    const targetHeight = Math.round(this.height * dpr);

    if (this.canvas.width !== targetWidth || this.canvas.height !== targetHeight) {
      this.canvas.width = targetWidth;
      this.canvas.height = targetHeight;
      this.canvas.style.width = `${this.width}px`;
      this.canvas.style.height = `${this.height}px`;
      this.ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.ctx.scale(dpr, dpr);
    }

    this.centerX = this.width / 2;
    this.centerY = this.height / 2;
    this.orbRadius = Math.max(70, Math.min(120, Math.min(this.width, this.height) * 0.30));
  }

  scheduleNextBlink() {
    if (!this.autoBlinkEnabled || !this.running) return;
    const interval = Math.random() * 4000 + 3000;
    setTimeout(() => {
      this.triggerBlink();
      this.scheduleNextBlink();
    }, interval);
  }

  triggerBlink() {
    if (this.isBlinking) return;
    this.isBlinking = true;
    const startTime = performance.now();
    const duration = 150;

    const step = (now) => {
      const elapsed = now - startTime;
      const progress = elapsed / duration;

      if (progress < 0.5) {
        this.blinkValue = 1 - (progress * 2);
      } else if (progress <= 1.0) {
        this.blinkValue = (progress - 0.5) * 2;
      } else {
        this.blinkValue = 1.0;
        this.isBlinking = false;
        return;
      }
      if (this.running) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  clearBehaviors() {
    this.behaviorTimers.forEach(t => clearTimeout(t));
    this.behaviorTimers = [];
    this.overrideGaze = false;
  }

  applyEmotionTargets(targets) {
    for (let prop in targets) {
      if (this.springs[prop]) {
        this.springs[prop].set(targets[prop]);
      }
    }
  }

  setEmotion(key) {
    if (!EMOTIONS[key]) return;
    this.currentEmotion = key;
    const e = EMOTIONS[key];

    this.clearBehaviors();
    this.applyEmotionTargets(e);

    this.leftShapeType = e.shape || 'capsule';
    this.rightShapeType = e.shape || 'capsule';

    if (typeof e.behavior === 'function') {
      e.behavior(this);
    }

    if (this.labelElement) {
      this.labelElement.textContent = e.name;
    }
    const badge = typeof document !== 'undefined' ? document.getElementById('emotionBadge') : null;
    if (badge) badge.innerText = e.name;
  }

  setState(nextState = {}) {
    this.state = { ...this.state, ...nextState };
    const mapped = deriveVoiceFaceState(this.state);

    if (this.container) this.container.dataset.faceExpression = mapped.expression;
    if (mapped.theme && THEMES[mapped.theme]) this.currentTheme = mapped.theme;

    if (mapped.expression !== this.currentEmotion) {
      this.setEmotion(mapped.expression);
    }

    return mapped;
  }

  feedMicLevel(rms) {
    const level = clamp(Number(rms) * 1.4, 0, 1);
    this.state.micLevel = level;
    if (this.state.phase === "listening" || this.state.phase === "attending") {
      this.springs.orbPulse.set(level);
    }
  }

  feedAiLevel(level) {
    const clamped = clamp(Number(level), 0, 1);
    this.state.aiLevel = clamped;
    if (this.state.isAiSpeaking || this.state.phase === "speaking") {
      this.springs.orbPulse.set(clamped);
    }
  }

  addRipple(intensity) {
    if (this.ripples.length > 4) return;
    this.ripples.push({
      radius: this.orbRadius * 0.95,
      maxRadius: this.orbRadius * (1.25 + intensity * 0.3),
      alpha: 0.35 * Math.min(1.0, intensity * 1.2),
      speed: 1.2 + intensity * 2.5
    });
  }

  updatePhysics() {
    this.time += 0.015;

    // MindPal speaking organic wave pulse fallback if audio level isn't feeding real-time PCM RMS
    const isAiSpeaking = Boolean(this.state.isAiSpeaking || this.state.phase === "speaking");
    let syntheticAiVol = 0;
    if (isAiSpeaking && this.state.aiLevel < 0.05) {
      syntheticAiVol = 0.35 + Math.sin(this.time * 8) * 0.25 + Math.cos(this.time * 13) * 0.15;
    }

    const vol = Math.max(this.state.micLevel, this.state.aiLevel, syntheticAiVol);
    this.springs.orbPulse.set(vol);

    if (vol > 0.12 && Math.random() < 0.25) {
      this.addRipple(vol);
    }

    if (this.mouseTrackingEnabled && !this.overrideGaze) {
      const dx = this.mouseX - this.centerX;
      const dy = this.mouseY - this.centerY;
      const maxDist = Math.max(1, Math.min(this.width, this.height) * 0.4);

      let gazeTargetX = (dx / maxDist) * 12;
      let gazeTargetY = (dy / maxDist) * 10;

      gazeTargetX = isNaN(gazeTargetX) ? 0 : Math.max(-12, Math.min(12, gazeTargetX));
      gazeTargetY = isNaN(gazeTargetY) ? 0 : Math.max(-10, Math.min(10, gazeTargetY));

      // Add gentle dynamic voice gaze drift when speaking/listening
      if (vol > 0.05) {
        gazeTargetX += Math.sin(this.time * 5) * 3 * vol;
        gazeTargetY += Math.cos(this.time * 4) * 2 * vol;
      }

      this.springs.gazeX.set(gazeTargetX);
      this.springs.gazeY.set(gazeTargetY);
    } else if (!this.overrideGaze) {
      this.springs.gazeX.set(Math.sin(this.time * 3) * 2 * vol);
      this.springs.gazeY.set(Math.cos(this.time * 2.5) * 2 * vol);
    }

    for (let key in this.springs) {
      this.springs[key].update();
    }

    this.meshRotation += 0.005 + (vol * 0.02);

    for (let i = this.ripples.length - 1; i >= 0; i--) {
      const r = this.ripples[i];
      r.radius += r.speed;
      r.alpha *= 0.96;
      if (r.alpha < 0.01 || r.radius >= r.maxRadius) {
        this.ripples.splice(i, 1);
      }
    }
  }

  drawFluidOrb(floatY) {
    const ctx = this.ctx;
    const theme = THEMES[this.currentTheme] || THEMES.geminiCore;

    const pulseVal = this.springs.orbPulse.current;
    const currentRadius = this.orbRadius + (pulseVal * 18) + (Math.sin(this.time * 1.5) * 3);

    ctx.save();
    ctx.translate(this.centerX, this.centerY + floatY);

    const bgGlowGrad = ctx.createRadialGradient(0, 0, currentRadius * 0.4, 0, 0, currentRadius * 1.6);
    bgGlowGrad.addColorStop(0, theme.bgGlow);
    bgGlowGrad.addColorStop(1, 'rgba(0,0,0,0)');

    ctx.beginPath();
    ctx.arc(0, 0, currentRadius * 1.6, 0, Math.PI * 2);
    ctx.fillStyle = bgGlowGrad;
    ctx.fill();

    ctx.beginPath();
    const points = 120;
    for (let i = 0; i <= points; i++) {
      const angle = (i / points) * Math.PI * 2;
      const distortion = Math.sin(angle * 3 + this.time * 2) * (2 + pulseVal * 6) +
                         Math.cos(angle * 5 - this.time * 1.5) * (1.5 + pulseVal * 4);
      const r = currentRadius + distortion;
      const x = Math.cos(angle) * r;
      const y = Math.sin(angle) * r;

      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();

    const rot = this.meshRotation;
    const gx1 = Math.cos(rot) * currentRadius * 0.9;
    const gy1 = Math.sin(rot) * currentRadius * 0.9;
    const baseGrad = ctx.createLinearGradient(gx1, gy1, -gx1, -gy1);

    const s = theme.stops;
    baseGrad.addColorStop(0, `rgb(${s[0].r}, ${s[0].g}, ${s[0].b})`);
    baseGrad.addColorStop(0.5, `rgb(${s[1].r}, ${s[1].g}, ${s[1].b})`);
    baseGrad.addColorStop(1, `rgb(${s[2].r}, ${s[2].g}, ${s[2].b})`);

    ctx.fillStyle = baseGrad;
    ctx.shadowColor = `rgba(${s[0].r}, ${s[0].g}, ${s[0].b}, 0.4)`;
    ctx.shadowBlur = 35;
    ctx.fill();

    const node1X = Math.cos(this.time * 0.9) * currentRadius * 0.3;
    const node1Y = Math.sin(this.time * 0.8) * currentRadius * 0.3;
    const node1Grad = ctx.createRadialGradient(node1X, node1Y, 0, node1X, node1Y, currentRadius * 0.85);
    node1Grad.addColorStop(0, `rgba(${s[2].r}, ${s[2].g}, ${s[2].b}, 0.75)`);
    node1Grad.addColorStop(1, 'rgba(0, 0, 0, 0)');

    ctx.fillStyle = node1Grad;
    ctx.fill();

    const coreGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, currentRadius);
    coreGrad.addColorStop(0, 'rgba(255, 255, 255, 0.25)');
    coreGrad.addColorStop(0.5, 'rgba(255, 255, 255, 0.05)');
    coreGrad.addColorStop(1, 'rgba(0, 0, 0, 0.15)');

    ctx.fillStyle = coreGrad;
    ctx.fill();

    ctx.restore();
    return currentRadius;
  }

  updateMorphPhysics(effLeftWidth, effLeftHeight, effRightWidth, effRightHeight, radius) {
    const stiffness = 0.22;
    const damping = 0.65;

    const targetLeft = EyeShapes[this.leftShapeType](effLeftWidth, effLeftHeight, radius, false);
    const targetRight = EyeShapes[this.rightShapeType](effRightWidth, effRightHeight, radius, true);

    for(let i=0; i<60; i++) {
      let fxL = (targetLeft[i].x - this.leftPts[i].x) * stiffness;
      let fyL = (targetLeft[i].y - this.leftPts[i].y) * stiffness;
      this.leftPts[i].vx = (this.leftPts[i].vx + fxL) * damping;
      this.leftPts[i].vy = (this.leftPts[i].vy + fyL) * damping;
      this.leftPts[i].x += this.leftPts[i].vx;
      this.leftPts[i].y += this.leftPts[i].vy;

      let fxR = (targetRight[i].x - this.rightPts[i].x) * stiffness;
      let fyR = (targetRight[i].y - this.rightPts[i].y) * stiffness;
      this.rightPts[i].vx = (this.rightPts[i].vx + fxR) * damping;
      this.rightPts[i].vy = (this.rightPts[i].vy + fyR) * damping;
      this.rightPts[i].x += this.rightPts[i].vx;
      this.rightPts[i].y += this.rightPts[i].vy;
    }
  }

  drawPolyEye(ctx, x, y, angleDeg, pts, blinkScale) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate((angleDeg * Math.PI) / 180);
    ctx.scale(1, Math.max(0.01, blinkScale));

    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for(let i=1; i<60; i++) {
      ctx.lineTo(pts[i].x, pts[i].y);
    }
    ctx.closePath();

    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = 'rgba(255, 255, 255, 0.9)';
    ctx.shadowBlur = 10;
    ctx.fill();

    ctx.restore();
  }

  drawEyes(floatY) {
    const ctx = this.ctx;
    const sp = this.springs;

    const gazeX = sp.gazeX.current;
    const gazeY = sp.gazeY.current;

    const scale = this.orbRadius / 180;

    const offsetY = sp.offsetY.current * scale;
    const spacing = sp.spacing.current * scale;
    const width = sp.width.current * scale;
    const height = sp.height.current * scale;

    let eyeCenterX = this.centerX + gazeX * scale;
    let eyeCenterY = this.centerY + floatY + offsetY + (gazeY * scale);

    const maxEyeDist = this.orbRadius * 0.55;
    const distFromCenter = Math.hypot(eyeCenterX - this.centerX, eyeCenterY - (this.centerY + floatY));
    if (distFromCenter > maxEyeDist) {
      const angle = Math.atan2(eyeCenterY - (this.centerY + floatY), eyeCenterX - this.centerX);
      eyeCenterX = this.centerX + Math.cos(angle) * maxEyeDist;
      eyeCenterY = this.centerY + floatY + Math.sin(angle) * maxEyeDist;
    }

    const voiceExpand = sp.orbPulse.current * 4 * scale;
    const effWidth = Math.max(3, width + voiceExpand * 0.3);
    const effLeftHeight = Math.max(3, (height * sp.leftHeightMult.current + voiceExpand));
    const effRightHeight = Math.max(3, (height * sp.rightHeightMult.current + voiceExpand));

    this.updateMorphPhysics(effWidth, effLeftHeight, effWidth, effRightHeight, sp.radius.current * scale);

    const halfSpacing = spacing / 2;

    const leftX = eyeCenterX - halfSpacing;
    const leftAngle = sp.angle.current + sp.leftAngleAdd.current;
    this.drawPolyEye(ctx, leftX, eyeCenterY, leftAngle, this.leftPts, this.blinkValue);

    const rightX = eyeCenterX + halfSpacing;
    const rightAngle = -sp.angle.current + sp.rightAngleAdd.current;
    this.drawPolyEye(ctx, rightX, eyeCenterY, rightAngle, this.rightPts, this.blinkValue);
  }

  drawRipples(floatY) {
    this.ripples.forEach(r => {
      this.ctx.save();
      this.ctx.beginPath();
      this.ctx.arc(this.centerX, this.centerY + floatY, r.radius, 0, Math.PI * 2);
      this.ctx.strokeStyle = `rgba(168, 199, 250, ${r.alpha})`;
      this.ctx.lineWidth = 1.2;
      this.ctx.shadowBlur = 8;
      this.ctx.shadowColor = 'rgba(168, 199, 250, 0.4)';
      this.ctx.stroke();
      this.ctx.restore();
    });
  }

  render() {
    if (!this.ctx || !this.canvas) return;

    if (this.canvas.clientWidth && this.canvas.clientHeight) {
      const cw = this.canvas.clientWidth;
      const ch = this.canvas.clientHeight;
      if (Math.abs(this.width - cw) > 1 || Math.abs(this.height - ch) > 1) {
        this.resize();
      }
    }

    // Clear canvas so the face orb rendered on canvas is completely transparent
    // and seamlessly floats over the dark fullscreen voice overlay surface.
    this.ctx.clearRect(0, 0, this.width, this.height);

    this.updatePhysics();

    const floatY = Math.sin(this.time * 1.2) * 5;

    this.drawRipples(floatY);
    this.drawFluidOrb(floatY);
    this.drawEyes(floatY);
  }

  animate() {
    if (!this.running) return;
    this.render();
    this.frameId = requestAnimationFrame(() => this.animate());
  }
}

let renderer = null;
let state = { ...DEFAULT_STATE };

export function initVoiceFace({ canvasId = "voice-face-canvas", labelId = "voice-face-state-label" } = {}) {
  const canvas = typeof document !== 'undefined' ? document.getElementById(canvasId) : null;
  const label = typeof document !== 'undefined' ? document.getElementById(labelId) : null;
  if (!canvas) return false;
  renderer?.dispose?.();
  renderer = new AIFaceCanvas(canvas, label);
  renderer.setState(state);
  return true;
}

export function startVoiceFace(options = {}) {
  if (!renderer) initVoiceFace();
  renderer?.setState(state);
  return renderer?.start?.() || false;
}

export function stopVoiceFace() {
  renderer?.stop?.();
}

export function disposeVoiceFace() {
  renderer?.dispose?.();
  renderer = null;
}

export function setVoiceFaceState(nextState = {}) {
  state = { ...state, ...nextState };
  if (renderer) return renderer.setState(state);
  return deriveVoiceFaceState(state);
}

export function setVoiceFaceDiagnostic(event = {}) {
  const type = String(event.type || "");
  if (["provider.error", "voice.socket-error", "voice.provider-error", "transport.error"].includes(type)) {
    setVoiceFaceState({ phase: "error", error: true, faceExpression: "dead" });
  }
}

export function feedVoiceFaceMicLevel(input) {
  const rms = typeof input === "object" && input !== null ? input.rms : input;
  const num = Number(rms) || 0;
  renderer?.feedMicLevel?.(num);
  state = { ...state, micLevel: num };
}

export function feedVoiceFaceAiLevel(input) {
  const level = typeof input === "object" && input !== null ? input.level : input;
  const num = Number(level) || 0;
  renderer?.feedAiLevel?.(num);
  state = { ...state, aiLevel: num };
}

export function setVoiceFaceAnalysers({ mic = null, ai = null } = {}) {
  // Analysers passed for direct audio processing if needed
}

export function getVoiceFaceSnapshot() {
  return {
    ...deriveVoiceFaceState(state),
    running: Boolean(renderer?.running),
    micLevel: state.micLevel || 0,
    aiLevel: state.aiLevel || 0,
  };
}
