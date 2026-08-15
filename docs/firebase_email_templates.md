# MindPal Firebase Authentication Email Templates

## Purpose

This pack gives MindPal a calm, trustworthy, security-focused voice across the four Firebase Authentication emails configured in the project: email verification, password reset, email address change, and multi-factor enrollment notification.

The visual direction is deliberately native to MindPal: **quiet white space, dark ink, soft gray surfaces, a compact structure, plain-language security guidance, and no gradients or promotional styling**. The design references the product's existing light interface tokens: `#ffffff` paper, `#f0f4f9` soft surface, `#1f1f1f` primary ink, `#444746` secondary copy, and `#e0e0e0` dividers.

> Firebase's built-in email templates have **limited visual customization**. Use the **Console copy** below in the Firebase email editor. The optional HTML system is for a future custom SMTP/email-provider integration; do not paste the HTML into Firebase unless the console explicitly supports HTML source for the relevant field.

## Firebase Console application

Open **Firebase Console → Authentication → Templates** and edit each email type. Preserve the action-link token that Firebase inserts in the editor. In this guide it is represented as `%LINK%`; if the Firebase editor shows a different token, use the editor's token unchanged.

| Firebase email type | MindPal subject | Action link required | Recommended sender name |
| --- | --- | --- | --- |
| Email address verification | Confirm your MindPal email | Yes | MindPal |
| Password reset | Reset your MindPal password | Yes | MindPal Security |
| Email address change | Review your MindPal email change | Yes, if offered by the Firebase template | MindPal Security |
| Multi-factor enrollment notification | A sign-in method was added to MindPal | No | MindPal Security |

Use only the placeholders already offered by the Firebase editor. In the copy below, `%EMAIL%`, `%NEW_EMAIL%`, and `%LINK%` are illustrative Firebase substitutions. Do not delete, rename, or hand-build the action URL.

## Console-ready email copy

### 1. Email address verification

**Subject**

```text
Confirm your MindPal email
```

**Body**

```text
MindPal

Confirm your email

You are almost ready to keep your MindPal private and available across your devices.

Please confirm the email address for your account:
%EMAIL%

Confirm email
%LINK%

If you did not create a MindPal account, you can safely ignore this message.

For your security, MindPal will never ask for your password by email.
```

**Preview line**

```text
Confirm your email to protect and sync your MindPal.
```

### 2. Password reset

**Subject**

```text
Reset your MindPal password
```

**Body**

```text
MindPal Security

Reset your password

We received a request to reset the password for your MindPal account:
%EMAIL%

Reset password
%LINK%

This link is time-limited and can be used once.

If you did not request a password reset, no action is needed. Your current password will remain active.
```

**Preview line**

```text
Use this secure, time-limited link to reset your MindPal password.
```

### 3. Email address change

**Subject**

```text
Review your MindPal email change
```

**Body — use when the editor provides a security/review action link**

```text
MindPal Security

Review an email change

A request was made to change the email address on your MindPal account.

Current email:
%EMAIL%

New email:
%NEW_EMAIL%

Review this change
%LINK%

If you made this change, no further action is needed. If you did not, use the secure link above immediately.
```

**Body — use when the Firebase template is notification-only**

```text
MindPal Security

Your account email was changed

The email address on your MindPal account was updated.

If you made this change, no further action is needed.

If you did not make this change, reset your MindPal password immediately and contact support from within the app.
```

**Preview line**

```text
Review this important change to your MindPal account.
```

### 4. Multi-factor enrollment notification

**Subject**

```text
A sign-in method was added to MindPal
```

**Body**

```text
MindPal Security

A new sign-in method was added

A multi-factor sign-in method was added to your MindPal account.

If this was you, no further action is needed.

If you did not make this change, reset your password immediately and review your account security.

For your protection, MindPal will never ask for a verification code by email.
```

**Preview line**

```text
A new sign-in method was added to your MindPal account.
```

## Full branded HTML system for a custom email provider

Use the following shell only with a custom mail sender, such as an SMTP provider. Substitute the placeholders server-side and generate Firebase action links securely with the Admin SDK. Firebase documents this approach for fully customized email templates and delivery.[^firebase-custom]

```html
<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="x-apple-disable-message-reformatting" />
    <title>{{SUBJECT}}</title>
  </head>
  <body style="margin:0;padding:0;background:#f0f4f9;color:#1f1f1f;font-family:Arial,Helvetica,sans-serif;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">{{PREHEADER}}</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f0f4f9;">
      <tr>
        <td align="center" style="padding:32px 16px 40px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;">
            <tr>
              <td style="padding:0 4px 16px;font-size:18px;line-height:24px;font-weight:700;letter-spacing:-0.2px;color:#1f1f1f;">MindPal</td>
            </tr>
            <tr>
              <td style="background:#ffffff;border:1px solid #e0e0e0;border-radius:12px;padding:32px 28px 28px;">
                <div style="width:32px;height:3px;margin:0 0 22px;background:#1f1f1f;font-size:0;line-height:0;">&nbsp;</div>
                <h1 style="margin:0 0 12px;font-size:24px;line-height:31px;font-weight:650;letter-spacing:-0.35px;color:#1f1f1f;">{{HEADING}}</h1>
                <p style="margin:0 0 18px;font-size:15px;line-height:23px;color:#444746;">{{INTRODUCTION}}</p>
                <div style="margin:0 0 24px;padding:14px 16px;background:#f0f4f9;border-left:3px solid #1f1f1f;font-size:14px;line-height:21px;color:#444746;">{{ACCOUNT_CONTEXT}}</div>
                <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                  <tr>
                    <td align="center" style="border-radius:8px;background:#1f1f1f;">
                      <a href="{{ACTION_LINK}}" style="display:inline-block;padding:12px 18px;border:1px solid #1f1f1f;border-radius:8px;color:#ffffff;font-size:14px;font-weight:700;line-height:20px;text-decoration:none;">{{ACTION_LABEL}}</a>
                    </td>
                  </tr>
                </table>
                <p style="margin:24px 0 0;font-size:13px;line-height:20px;color:#6b7280;">{{SECURITY_NOTE}}</p>
              </td>
            </tr>
            <tr>
              <td style="padding:18px 4px 0;font-size:12px;line-height:18px;color:#6b7280;">
                MindPal · Private support that remembers what matters<br />
                If the button does not work, copy this link into your browser:<br />
                <a href="{{ACTION_LINK}}" style="color:#444746;word-break:break-all;">{{ACTION_LINK}}</a>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
```

### HTML substitutions by email type

| Type | `{{HEADING}}` | `{{ACTION_LABEL}}` | `{{ACCOUNT_CONTEXT}}` | `{{SECURITY_NOTE}}` |
| --- | --- | --- | --- | --- |
| Verification | Confirm your email | Confirm email | `Email to confirm: {{EMAIL}}` | If you did not create a MindPal account, you can safely ignore this email. |
| Password reset | Reset your password | Reset password | `Password reset requested for: {{EMAIL}}` | This secure link is time-limited and can be used once. If you did not request it, your password remains unchanged. |
| Email change | Review an email change | Review change | `Current email: {{EMAIL}}<br />New email: {{NEW_EMAIL}}` | If this was not you, review the change immediately and reset your password. |
| MFA enrollment | A sign-in method was added | Review security | `A multi-factor sign-in method was added to: {{EMAIL}}` | If this was not you, reset your password immediately and review account security. |

## Domain and action-link notes

Do not use `mindpal-demo.vercel.app` as a mail sender domain; it is a Vercel deployment subdomain, not a domain MindPal controls for email DNS. Firebase requires DNS verification before a custom authentication email domain can be applied.[^firebase-domain]

For now, keep Firebase's hosted action handler and sender infrastructure. If MindPal later has an owned domain, such as `mindpal.app`, the recommended sequence is to verify that domain in Firebase Templates, then apply it to the authentication email domain. For full branded HTML emails, generate action links from the server with Firebase Admin and deliver them through a verified transactional email provider; Firebase describes its stock template emails as having limited customization.[^firebase-custom]

## References

[^firebase-custom]: [Firebase — Generating Email Action Links](https://firebase.google.com/docs/auth/admin/email-action-links)
[^firebase-domain]: [Firebase — Use a Custom Domain for Authentication Emails](https://firebase.google.com/docs/auth/email-custom-domain)
[^firebase-handler]: [Firebase — Create Custom Email Action Handlers](https://firebase.google.com/docs/auth/custom-email-handler)
