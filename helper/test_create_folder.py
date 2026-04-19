import os
from pathlib import Path

# Example path under the cross-platform default orders root
path = str(Path.home() / "Spaila" / "orders" / "2026" / "april" / "C, STEPHANIE – 4023577985")

try:
    os.makedirs(path, exist_ok=True)
    print("[SUCCESS] Folder created or already exists:")
    print(path)
except Exception as e:
    print("[ERROR] Failed to create folder:")
    print(e)
