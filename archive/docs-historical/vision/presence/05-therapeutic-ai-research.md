# 05 — Therapeutic AI Research & Ethics

## Goal
Understand what published research says about AI-facilitated therapy,
where it works, where it fails, and what ethical framework governs
MindPal Presence as a therapeutic tool.

---

## What Research Says About AI Therapy

### Positive Evidence

**Woebot (CBT chatbot, Stanford 2017)**
- RCT: 70 college students with depression/anxiety
- Woebot group showed significant reduction in anxiety (PHQ-9) vs control
- Engagement: users messaged Woebot on average 12.14 days out of 14
- Limitation: text-only, no real-time voice/video

**Wysa (AI therapy app, 2018-2022)**
- 40% of users showed clinically significant improvement in PHQ-4 scores
- 91% found it helpful for managing low mood
- Limitation: structured menus, not open-ended conversation

**GPT-4 Mental Health Study (2023)**
- GPT-4 demonstrated comparable empathy scores to human therapists on
  standardized measures (Jefferson Empathy Scale)
- Limitation: simulated responses; not a live therapy study

**Meta-analysis: AI chatbots for depression (2023, n=8 RCTs)**
- Small-to-moderate effect size (d=0.56) for depression reduction
- Effect strongest for mild-to-moderate depression
- No evidence of harm in any trial

### Important Limitations

- No RCT exists for AI-facilitated *couples* or *group* therapy
- Most studies are text-only chatbots — camera/voice adds new variables
- Emotion detection from camera is not validated as a clinical tool
- Long-term efficacy beyond 8 weeks is unknown
- Most studies use self-selected, tech-comfortable populations

---

## Where AI Therapy Works (Evidence-Based Use Cases)

| Use case | Evidence level | Notes |
|---|---|---|
| Mild-moderate depression | Moderate | Multiple RCTs |
| Generalized anxiety | Moderate | Multiple RCTs |
| CBT skill practice | Strong | High engagement + outcomes |
| Psychoeducation | Strong | Delivering information reliably |
| Between-session support | Moderate | Journaling, check-ins |
| Crisis detection + escalation | Limited | Flags only; human follow-up needed |
| Couples conflict mediation | None | No published AI studies |
| Group therapy facilitation | None | No published AI studies |

**Implication for MindPal Presence**: Solo mode has the strongest evidence base.
Couples and Group mode are novel — we must monitor outcomes and build evidence.

---

## Ethical Framework

### What MindPal Presence Is
- A supportive, evidence-informed AI companion
- A space for reflection, dialogue, and skill practice
- A tool to increase access to mental health support

### What MindPal Presence Is NOT
- A replacement for licensed therapy or psychiatry
- A diagnostic tool (cannot diagnose any mental health condition)
- A crisis intervention service (has limits; must refer to humans)

### Mandatory Guardrails

1. **Crisis Escalation Protocol**: If any participant expresses suicidal ideation,
   self-harm, or acute crisis — MindPal immediately:
   - Pauses the session
   - Provides crisis resources (988, Crisis Text Line, local emergency)
   - Recommends human professional support
   - Does NOT continue the therapeutic conversation until the person confirms safety

2. **Scope Limitation**: MindPal will not diagnose, will not prescribe, will not
   replace professional advice. Every session ends with an offer to connect to
   a human professional if desired.

3. **Emotion Inference Disclosure**: Users are told that emotion estimates from
   camera are approximate, not clinical, and are used only to guide conversation
   pacing — not to make judgments about mental state.

4. **Minor Protection**: MindPal Presence is for users 18+. Age verification
   required before camera access is granted.

5. **Cultural Competency**: Body language signals vary by culture. The YOLO
   signal interpretation layer must be configurable/adaptable. "Avoiding eye
   contact" means disrespect in some cultures and respect in others.

---

## Therapeutic Modalities MindPal Can Draw From

| Modality | Applicability to Presence |
|---|---|
| CBT (Cognitive Behavioral Therapy) | High — structured, skill-based, works in short sessions |
| DBT (Dialectical Behavior Therapy) | High — emotion regulation, distress tolerance |
| Motivational Interviewing | High — open questions, reflective listening |
| Gottman Method (couples) | High — turn-taking, validation, de-escalation |
| ACT (Acceptance & Commitment) | Medium — values clarification, mindfulness prompts |
| EMDR | Low — requires trained therapist, specific eye movement protocol |
| Psychoanalysis | None — too unstructured, long-term |

---

## Professional Oversight Model (Future)

Vision for V3+:
- Licensed therapists can create a "supervised Presence" session
- MindPal runs the session, therapist monitors in real-time via dashboard
- Therapist can intervene (type a suggestion that MindPal voices)
- Creates a hybrid human-AI therapy model at scale
- Requires specific HIPAA BAA + therapist licensing legal review

---

## Open Items
- [ ] Commission literature review: couples AI therapy — any adjacent research?
- [ ] Consult with 3 licensed therapists on session director intervention logic
- [ ] Design IRB-compliant pilot study for Couples mode (pre-launch validation)
- [ ] Define outcome metrics: what does "success" mean for a Presence session?
- [ ] Review APA guidelines on technology in mental health practice (2020)
- [ ] Hire clinical advisory board before launch: 2 therapists + 1 ethicist minimum
