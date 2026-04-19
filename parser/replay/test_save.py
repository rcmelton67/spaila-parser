from parser.ingest import load_eml
from parser.sanitize import sanitize
from parser.replay.fingerprint import compute_template_id
from parser.replay.store import save_assignment

# Load and sanitize EXACTLY like pipeline
eml = load_eml("tests/samples/2353.eml")
clean_text = sanitize(eml)

# Compute correct template_id
template_id = compute_template_id(clean_text)

# Save replay
save_assignment(template_id, "price", "29.99")

print(f"Saved replay for template_id: {template_id}")
