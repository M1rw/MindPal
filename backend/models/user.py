from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field, model_validator


class UserSession(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    user_id_hash: str = ""
    raw_user_id: str = ""
    is_authenticated: bool = False
    email: str | None = None
    provider: str = "anonymous"


class UserProfile(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    user_id_hash: str = Field(min_length=1)
    display_name: str = "MindPal User"
    created_at: str | None = None
    settings: dict[str, object] = Field(default_factory=dict)
    email: str | None = None
    provider: str | None = None


class UserProfileResponse(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    profile: UserProfile
    loaded: bool = True
    provider: str | None = None

    @model_validator(mode="before")
    @classmethod
    def _normalize_flat_payload(cls, data):
        if not isinstance(data, dict):
            return data
        if "profile" not in data:
            profile_data = {
                "user_id_hash": data.get("user_id_hash", ""),
                "display_name": data.get("display_name", "MindPal User"),
                "created_at": data.get("created_at"),
                "settings": data.get("settings", {}),
                "email": data.get("email"),
                "provider": data.get("provider"),
            }
            return {"profile": profile_data, "loaded": data.get("loaded", True), "provider": data.get("provider")}
        return data
