from parser.pipeline import parse_eml
from parser.anchors.store import save_anchor
from parser.replay.fingerprint import compute_template_id
from parser.ingest import load_eml
from parser.sanitize import sanitize

path = "tests/samples/2353.eml"

result = parse_eml(path)

# pick correct candidate manually (first matching price)
price_candidate = next(
    c for c in result["candidates"] if c.value == "29.99"
)

eml = load_eml(path)
clean_text = sanitize(eml)
template_id = compute_template_id(clean_text)

save_anchor(template_id, "price", price_candidate)

print("Anchor saved")
