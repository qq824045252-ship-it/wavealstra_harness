### Electrostatic — Known PyAEDT Pitfalls (2026-09-05, v1.5.0)

**1. `create_design` with `solution_type` string**
The MCP `create_design(app_type="Maxwell3d", solution_type="Electrostatic")` internally maps the string to the wrong enum and creates a **Magnetostatic** design instead.

✅ Workaround: Use `run_python_code` with PyAEDT:
```python
from ansys.aedt.core.generic.constants import SolutionsMaxwell3D
m3d = Maxwell3d(solution_type=SolutionsMaxwell3D.ElectroStatic, ...)
```
or pass the string via MCP then confirm with `m3d.solution_type` afterwards.

**2. Voltage assignment requires a single planar face**
`assign_voltage(assignment=["BottomPlate"])` fails: "Cannot apply Voltage Excitation to non planar entity."

✅ Workaround: Use face IDs obtained via `get_object_faces()`:
```python
all_faces = m3d.modeler.get_object_faces("BottomPlate")  # e.g. [7,9,10,11,8,12]
inner_face = all_faces[0]  # identify by get_face_center() — the face at z=0 for bottom plate
m3d.assign_voltage(assignment=[inner_face], amplitude=0.0, name="VB")
```
Identify the correct planar face by checking face centers:
```python
for fid in m3d.modeler.get_object_faces("ObjectName"):
    print(fid, m3d.modeler.get_face_center(fid))
```

**3. Single block for modeling→solve→read results**
Calling `Maxwell3d(design=..., project=...)` in a **separate** `run_python_code` invocation after solving returns an object with an **empty setups list** (`m3d.setups == []`), making result extraction impossible. This is a PyAEDT object-cache issue across gRPC calls.

✅ Workaround: Keep geometry creation, material assignment, boundary/matrix setup, solve, and result reading in **one `run_python_code` block**. Do not split into multiple MCP `run_python_code` calls.

**4. Setup-level `export_matrix` bug**
`setup.export_matrix(matrix_type="C", matrix_name="...", output_file="...")` calls `self._app.export_c_matrix()` internally, but `Maxwell3D` has no such method.

✅ Workaround: Use the **design-level** method:
```python
m3d.export_matrix(matrix_name="CapacitanceMatrix", output_file=path, ...)
```
The `matrix_type` parameter is not needed on the design-level method.

**5. Matrix/expression naming**
- The exported expression format is: `{MatrixName}.{Quantity}({SignalName},{GroundName})`.
- For capacitance: `CM.C(VT,VT)` gives the **self-capacitance** of VT (top plate) in pF.
- Use `available_report_quantities(report_category="Matrix")` to discover which expressions exist after solving.
- `get_solution_data()` requires the **exact** expression string from that list.

**6. Mutual (transfer) capacitance**
In Maxwell Electrostatic's capacitance matrix, `C(Signal,Signal)` is the **total self-capacitance** of that conductor (includes both mutual and self terms). The mutual capacitance between two conductors is typically found from the off-diagonal terms: `C(Signal, Ground)` or exported matrix file inspection.
