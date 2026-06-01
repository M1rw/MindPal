import re
import logging
import httpx
from typing import Dict, Any, Tuple

from core.config import settings

# Initialize specific logger for the safety layer
logger = logging.getLogger("mindpal_safety")
logger.setLevel(logging.INFO)

# --- LOCAL DETERMINISTIC HEURISTICS ---
# Pre-compiled regex for ultra-fast (O(1)) local inference.
# Covers English and Arabic (Fusha/Dialects) to match the polyglot requirements.
CRISIS_PATTERN = re.compile(
    r"\b("
    r"suicide|kill myself|end my life|want to die|overdose|jump off|hang myself|no point in living|"
    r"انتحار|اقتل نفسي|انهي حياتي|اموت نفسي|خلاص مش قادر|ماعاد في فايدة|مفيش فايدة|انهي كل حاجة"
    r")\b",
    re.IGNORECASE
)

# Static, clinically-verified crisis response mapped by language
CRISIS_RESPONSE_EN = (
    "I'm pausing our conversation right now because what you just shared sounds incredibly heavy, "
    "and your safety is the absolute priority. As an AI, I cannot provide the level of care you deserve in this exact moment.\n\n"
    "**Please connect with a real human who can help you right now:**\n"
    "- **Call or Text:** 988 (US/Canada Suicide & Crisis Lifeline)\n"
    "- **Text:** HOME to 741741 (Crisis Text Line)\n"
    "- **International:** Please visit [Befrienders Worldwide](https://www.befrienders.org/) to find a hotline in your country.\n\n"
    "You do not have to carry this weight alone. Please reach out to them."
)

CRISIS_RESPONSE_AR = (
    "أنا هوقف كلامنا لحظة لأن اللي شاركته دلوقتي تقيل جداً، وسلامتك هي أهم حاجة. كذكاء اصطناعي، مقدرش أقدم لك الدعم الكافي اللي تستحقه في اللحظة دي.\n\n"
    "**أرجوك تواصل مع شخص حقيقي يقدر يساعدك فوراً:**\n"
    "- **في الطوارئ:** اتصل برقم الإسعاف في بلدك فوراً.\n"
    "- **دعم دولي:** زور موقع [Befrienders Worldwide](https://www.befrienders.org/) عشان تلاقي خط ساخن في بلدك.\n\n"
    "أنت مش مضطر تشيل الحمل ده لوحدك. أرجوك اطلب المساعدة."
)

# --- EXTERNAL API MODERATION ---

async def _check_perspective_api(client: httpx.AsyncClient, message: str) -> Dict[str, float]:
    """
    Calls Google's Perspective API to evaluate the text for Toxicity and Threats.
    Fails gracefully and silently if the API key is not configured or if the API times out.
    """
    # Use getattr to prevent crashes if the key wasn't added to config.py yet
    api_key = getattr(settings, "PERSPECTIVE_API_KEY", None)
    if not api_key:
        return {}

    url = f"https://commentanalyzer.googleapis.com/v1alpha1/comments:analyze?key={api_key}"
    
    payload = {
        "comment": {"text": message},
        "languages": ["en", "ar"], # Support our primary language targets
        "requestedAttributes": {
            "TOXICITY": {},
            "SEVERE_TOXICITY": {},
            "THREAT": {}
        }
    }

    try:
        # Extremely short timeout (2.0s) so moderation doesn't degrade the chat experience
        response = await client.post(url, json=payload, timeout=2.0)
        response.raise_for_status()
        data = response.json()
        
        # Extract probabilities safely
        scores = {
            "TOXICITY": data["attributeScores"]["TOXICITY"]["summaryScore"]["value"],
            "SEVERE_TOXICITY": data["attributeScores"]["SEVERE_TOXICITY"]["summaryScore"]["value"],
            "THREAT": data["attributeScores"]["THREAT"]["summaryScore"]["value"]
        }
        return scores
        
    except httpx.TimeoutException:
        logger.warning("Perspective API timed out. Defaulting to local heuristics.")
        return {}
    except Exception as e:
        logger.warning(f"Perspective API error: {str(e)}. Defaulting to local heuristics.")
        return {}

# --- MAIN ORCHESTRATOR ---

async def analyze_message_safety(message: str) -> Tuple[bool, str, str]:
    """
    Evaluates a user message through the Multi-Layered Crisis Funnel.
    
    Returns:
        Tuple[is_safe (bool), reason (str), static_response (str)]
        - is_safe: True if the message can be sent to the LLM. False if it must be blocked.
        - reason: Internal logging reason (e.g., 'local_crisis_regex', 'high_threat_api').
        - static_response: The verified emergency text to return to the user if blocked.
    """
    # 1. LOCAL HEURISTIC CHECK (Fastest, zero latency)
    if CRISIS_PATTERN.search(message):
        logger.warning(f"CRISIS INTERCEPT (Local Regex) triggered for message: '{message[:30]}...'")
        
        # Quick language detection to return the right fallback
        if any(char >= '\u0600' and char <= '\u06FF' for char in message):
            return False, "local_crisis_regex", CRISIS_RESPONSE_AR
        return False, "local_crisis_regex", CRISIS_RESPONSE_EN

    # 2. EXTERNAL ML MODERATION (Perspective API)
    # Using a transient client since this is a lightweight, isolated call
    async with httpx.AsyncClient() as client:
        scores = await _check_perspective_api(client, message)
        
        # Thresholds: Flag if Threat > 85% or Severe Toxicity > 90%
        if scores.get("THREAT", 0.0) > 0.85:
            logger.warning(f"CRISIS INTERCEPT (Perspective THREAT={scores['THREAT']})")
            return False, "high_threat_api", CRISIS_RESPONSE_EN
            
        if scores.get("SEVERE_TOXICITY", 0.0) > 0.90:
            logger.warning(f"CRISIS INTERCEPT (Perspective TOXICITY={scores['SEVERE_TOXICITY']})")
            return False, "high_toxicity_api", "Your message violated our safety guidelines. Please maintain a respectful environment."

    # 3. MESSAGE IS SAFE
    return True, "safe", ""