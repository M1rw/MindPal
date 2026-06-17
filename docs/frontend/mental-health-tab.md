# Mental Health Tab

Displays clinical insights collected through MindPal Pro conversations.
Data comes from the `ClinicalProfile` model in the backend user profile.

## Data Sources

| Field | Backend Path | UI Element ID |
|-------|-------------|---------------|
| PHQ-9 scores | `profile.clinical.phq9_history` | `#phq9-chart` |
| GAD-7 scores | `profile.clinical.gad7_history` | `#gad7-chart` |
| Presenting problems | `profile.clinical.presenting_problems` | `#presenting-problems-display` |
| Suspected diagnoses | `profile.clinical.suspected_diagnoses` | `#suspected-diagnoses-display` |
| Treatment plan | `profile.clinical.treatment_plan` | `#treatment-plan-display` |

## Rendering

`updateMentalHealthUI(profileResponse)` in `frontend/js/ui_state.js` handles all rendering.

Called from:
- `app.js` line ~430 — when profile loads from local store
- `cloud_sync.js` line ~131 — when profile loads from cloud

### Charts (PHQ-9 / GAD-7)

Bar charts rendered as flexbox columns inside a container.

- **With data**: Colored bars (indigo for PHQ-9, purple for GAD-7) with hover tooltips showing score and date.
- **Without data**: Grey mock bars showing a realistic sample pattern. Tooltips say "Sample".
  - Mock PHQ-9: `[8, 12, 14, 11, 9, 7, 5]` (downward trend)
  - Mock GAD-7: `[6, 9, 12, 10, 8, 6, 4]` (downward trend)
  - Bar color: `bg-gray-300/60 dark:bg-gray-600/40`

Height is computed as `(score / maxScore) * 100%`:
- PHQ-9 max: 27
- GAD-7 max: 21
- Minimum height: 5%

### Text Sections

| Section | With Data | Without Data (Mock) |
|---------|-----------|-------------------|
| Presenting problems | Bulleted list from profile | Grey italic: "• Stress management • Sleep difficulties • Mood regulation" |
| Suspected diagnoses | Bulleted list from profile | Grey italic: "No observations yet — continue chatting with MindPal Pro." |
| Treatment plan | Plain text from profile | Grey italic: "No active plan — insights build over time through conversations." |

## Clinical Data Flow

```
User chats with MindPal Pro
  → Backend extracts clinical signals from conversation
  → Updates ClinicalProfile in Firestore user document
  → Frontend fetches profile on load / cloud sync
  → updateMentalHealthUI() renders the data
```

## Important Notes

- This is **not** a clinical tool. Suspected diagnoses are preliminary AI observations.
- The tab description states: "Preliminary observations — not a clinical diagnosis."
- All data is read-only in the UI. Users cannot edit clinical data directly.
- Clinical frameworks (CBT, DBT, ACT, MI) are documented in `docs/backend/rag-clinical-frameworks.md`.
