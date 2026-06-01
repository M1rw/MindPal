const signInBtn = document.getElementById("sign-in-btn");
const envChip = document.getElementById("env-chip");

if (signInBtn) {
    signInBtn.addEventListener("click", () => {
        if (envChip) envChip.textContent = "Local";
        signInBtn.textContent = "Sign in";
        alert("Auth wiring will be connected in backend phase.");
    });
}
