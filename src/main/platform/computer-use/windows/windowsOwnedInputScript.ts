/** Embedded in the existing native host; the ledger records only delivered SendInput edges. */
export const WINDOWS_OWNED_INPUT_SCRIPT = String.raw`
  private sealed class HeldControl { public string Owner; public INPUT Down; }
  private static readonly Dictionary<string, HeldControl> HeldInputs = new Dictionary<string, HeldControl>();
  public static readonly string InputHostInstance = Guid.NewGuid().ToString("N");
  private static string inputOwner = "__direct__";
  public static void BeginInput(string owner) { inputOwner = String.IsNullOrEmpty(owner) ? "__direct__" : owner; }
  public static bool OwnsControl(string control) { HeldControl held; return HeldInputs.TryGetValue(control, out held) && held.Owner == inputOwner; }
  private static string InputControl(INPUT input) {
    if (input.type == 1) return "key:" + input.U.ki.wVk + ":" + input.U.ki.wScan + ":" + (input.U.ki.dwFlags & 0x0004);
    if (input.type == 0) {
      uint flags = input.U.mi.dwFlags;
      if ((flags & 0x0006) != 0) return "mouse:left";
      if ((flags & 0x0018) != 0) return "mouse:right";
      if ((flags & 0x0060) != 0) return "mouse:middle";
    }
    return null;
  }
  private static bool InputDown(INPUT input) {
    return input.type == 1 ? (input.U.ki.dwFlags & 0x0002) == 0 : (input.U.mi.dwFlags & 0x002A) != 0;
  }
  private static int ControlVirtualKey(INPUT input) {
    if (input.type == 1) return input.U.ki.wVk;
    string control = InputControl(input);
    return control == "mouse:left" ? 1 : control == "mouse:right" ? 2 : control == "mouse:middle" ? 4 : 0;
  }
  private static INPUT ReleaseEdge(INPUT input) {
    if (input.type == 1) input.U.ki.dwFlags |= 0x0002;
    else input = Mouse((input.U.mi.dwFlags & 0x0002) != 0 ? 0x0004u : (input.U.mi.dwFlags & 0x0008) != 0 ? 0x0010u : 0x0040u, 0, 0, 0);
    return input;
  }
  private static void RecordInserted(INPUT[] inputs, uint inserted) {
    for (int index = 0; index < inputs.Length && index < inserted; index++) {
      INPUT input = inputs[index]; string control = InputControl(input);
      if (control == null) continue;
      if (InputDown(input)) HeldInputs[control] = new HeldControl { Owner = inputOwner, Down = input };
      else {
        HeldControl held;
        if (HeldInputs.TryGetValue(control, out held) && held.Owner == inputOwner) HeldInputs.Remove(control);
      }
    }
  }
  private static INPUT[] PrepareOwnedInput(IList<INPUT> inputs) {
    foreach (HeldControl held in HeldInputs.Values) if (held.Owner != inputOwner) return null;
    var downs = new HashSet<string>();
    foreach (INPUT input in inputs) { string control = InputControl(input); if (control != null && InputDown(input)) downs.Add(control); }
    var prepared = new List<INPUT>();
    foreach (INPUT input in inputs) {
      string control = InputControl(input);
      if (control != null) {
        HeldControl held;
        bool owned = HeldInputs.TryGetValue(control, out held) && held.Owner == inputOwner;
        if (InputDown(input)) {
          if (owned) continue; // A repeated DOWN/chord must preserve our earlier hold.
          int key = ControlVirtualKey(input);
          if (key != 0 && (GetAsyncKeyState(key) & 0x8000) != 0) return null; // Never acquire a user's already-held key/button.
        } else {
          if (owned && downs.Contains(control)) continue; // Paired transient UP must not release an earlier hold.
          if (!owned && !downs.Contains(control)) continue; // Never release non-owned controls.
        }
      }
      prepared.Add(input);
    }
    return prepared.ToArray();
  }
  public static string[] OwnedInputControls(string owner) {
    var controls = new List<string>();
    foreach (var pair in HeldInputs) if (pair.Value.Owner == owner) controls.Add(pair.Key);
    controls.Sort(StringComparer.Ordinal); return controls.ToArray();
  }
  public static bool ReleaseOwnedInput(string owner, string hostInstance, string[] expectedControls) {
    if (hostInstance != InputHostInstance || owner != inputOwner) return false;
    string[] controls = OwnedInputControls(owner);
    Array.Sort(expectedControls, StringComparer.Ordinal);
    if (controls.Length != expectedControls.Length) return false;
    for (int index = 0; index < controls.Length; index++) if (controls[index] != expectedControls[index]) return false;
    var releases = new List<INPUT>();
    foreach (string control in controls) releases.Add(ReleaseEdge(HeldInputs[control].Down));
    return SendBatch(releases) && OwnedInputControls(owner).Length == 0;
  }
`;
