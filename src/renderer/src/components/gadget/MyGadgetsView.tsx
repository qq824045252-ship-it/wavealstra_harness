import GadgetSection from "./GadgetSection";

export default function MyGadgetsView(): React.JSX.Element {
  return (
    <main className="gadget-page">
      <header className="gadget-page-header">
        <div><h1>My Gadgets</h1><p>Reusable tools available across MyBuddy</p></div>
      </header>
      <div className="gadget-page-body">
        <GadgetSection scope={{ type: "global" }} title="Personal toolbox" />
      </div>
    </main>
  );
}
