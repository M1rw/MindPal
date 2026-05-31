// Session and region utilities (ported from versions)
(function(){
    const REGION_OVERRIDE_KEY = 'mindpal.regionOverride';
    const SESSION_ID_KEY = 'mindpal.sessionId';

    function detectClientRegion() {
        try {
            const langs = Array.isArray(navigator.languages) && navigator.languages.length ? navigator.languages : [navigator.language || ''];
            const langBlob = langs.join(' ').toLowerCase();
            const tz = (Intl.DateTimeFormat().resolvedOptions().timeZone || '').toLowerCase();

            const isUSorCanada = /-us\b|\bus\b|-ca\b|\bcanada\b/.test(langBlob) || /(america\/|canada\/|toronto|vancouver|montreal)/.test(tz);
            if (isUSorCanada) return 'us_ca';

            const isUKorIreland = /-gb\b|\buk\b|-ie\b|\bireland\b|\benglish\b/.test(langBlob) || /(europe\/london|europe\/dublin)/.test(tz);
            if (isUKorIreland) return 'uk_ie';

            const isAustralia = /-au\b|\baustralia\b/.test(langBlob) || /australia\//.test(tz);
            if (isAustralia) return 'au';

            const isIndia = /-in\b|\bindia\b|\bhindi\b/.test(langBlob) || /asia\/kolkata/.test(tz);
            if (isIndia) return 'in';
        } catch (e) {
            console.warn('Region detect failed', e);
        }
        return 'global';
    }

    function generateSessionId() {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
        return `sess_${Date.now()}_${Math.random().toString(36).slice(2,10)}`;
    }

    function getOrCreateSessionId() {
        const existing = (localStorage.getItem(SESSION_ID_KEY) || '').trim();
        if (existing) return existing;
        const generated = generateSessionId();
        localStorage.setItem(SESSION_ID_KEY, generated);
        return generated;
    }

    function getStoredRegionOverride() {
        const raw = (localStorage.getItem(REGION_OVERRIDE_KEY) || 'auto').trim().toLowerCase();
        const allowed = new Set(['auto','us_ca','uk_ie','au','in','global']);
        return allowed.has(raw) ? raw : 'auto';
    }

    function getEffectiveRegion() {
        const override = getStoredRegionOverride();
        return override === 'auto' ? detectClientRegion() : override;
    }

    function getRegionLabel(code){
        const labels = { us_ca: 'U.S./Canada', uk_ie: 'UK/Ireland', au: 'Australia', in: 'India', global: 'Global' };
        return labels[code] || 'Global';
    }

    // Expose
    window.getOrCreateSessionId = getOrCreateSessionId;
    window.detectClientRegion = detectClientRegion;
    window.getEffectiveRegion = getEffectiveRegion;
    window.getRegionLabel = getRegionLabel;
})();
