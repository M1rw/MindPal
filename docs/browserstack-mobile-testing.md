# BrowserStack Real-Device Testing

MindPal is a web/PWA application, so BrowserStack should test the deployed HTTPS frontend in real mobile Safari and Chrome through Selenium WebDriver. Expo Go is not used because the current app is React DOM, not React Native.

## One-time setup

1. Create a BrowserStack Automate account with real-device web access.
2. Deploy MindPal to a staging HTTPS URL.
3. Set credentials as local environment variables. Do not commit them or paste them into source files.

PowerShell:

```powershell
$env:BROWSERSTACK_USERNAME = "your-username"
$env:BROWSERSTACK_ACCESS_KEY = "your-access-key"
$env:MINDPAL_STAGING_URL = "https://staging.example.com"
```

Optional device overrides:

```powershell
$env:BROWSERSTACK_IOS_DEVICE = "iPhone 14"
$env:BROWSERSTACK_IOS_VERSION = "16"
$env:BROWSERSTACK_ANDROID_DEVICE = "Samsung Galaxy S22"
$env:BROWSERSTACK_ANDROID_VERSION = "12"
```

Use the exact device names and OS versions available in the BrowserStack dashboard if the defaults are unavailable on your plan.

## Run the real-device smoke flow

```powershell
npm run test:mobile:browserstack
```

The runner tests both devices for:

- initial load
- horizontal overflow
- accessible control names
- mobile More actions menu
- History open/close
- composer input
- console errors
- page errors
- failed requests
- screenshots

Artifacts are written to `artifacts/frontend-quality/browserstack-mobile/`:

- `iphone-safari.png`
- `android-chrome.png`
- `latest.json`

BrowserStack also provides the session video, device metadata, network logs, and console logs in its dashboard.

The runner requests W3C/Appium mobile capabilities and rejects a desktop session. The current BrowserStack Automate endpoint may reject these capabilities with a message such as `Platform can be one of MAC, WIN8, XP, WINDOWS, and ANY`; that means the account/endpoint is desktop Automate only, not real mobile web automation. In that case, use BrowserStack Live for manual real-device sessions or a BrowserStack/App Automate-compatible native wrapper, or move the automated web test to a provider that exposes real mobile browsers through WebDriver.

## Important limitations

When the account accepts the mobile capabilities, this runner validates real-device browser rendering and interaction. Microphone permission and live voice should be tested in a separate approved scenario because cloud-device plans may restrict microphone access. Do not use real patient-like data or production accounts.

Manual real-device checks still required:

- microphone allow/deny and revoked permission
- Bluetooth route changes
- incoming phone call and app interruption
- VoiceOver and TalkBack
- Home Screen PWA install and relaunch
- keyboard while streaming and rotating
- offline/reconnect behavior

## Failure handling

The command exits with code `1` if either device has a page error, console error, failed request, or failed assertion. It exits with code `2` when required credentials or the staging URL are missing.