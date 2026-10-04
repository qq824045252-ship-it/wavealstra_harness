### `run_python_code` Session Discipline

Each `run_python_code` call executes in a **separate thread** with its own PyAEDT `Desktop()` instantiation. This means:
- **State is NOT shared** between calls. `m3d = Maxwell3d(design=..., project=...)` in one call does not see the setups/solutions created in a prior call.
- **Model changes are persisted** in the AEDT design (geometry, materials, boundaries survive).
- But **PyAEDT Python object state** (`.setups`, `.post`, `.modeler` references) may be stale or empty.

✅ Always structure as:
```python
# ONE block: model→assign→solve→read→save
from ansys.aedt.core import Maxwell3d
m3d = Maxwell3d(design="MyDesign", project="MyProject")
# ... geometry ...
# ... solve ...
sd = m3d.post.get_solution_data(...)
result = str(sd.full_matrix_mag_phase)
```
❌ Do NOT split into:
```python
# Call 1: build model
# Call 2: solve (may work)
# Call 3: read results → SETUPS EMPTY!
```
