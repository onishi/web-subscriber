import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, NavLink, Route, Routes } from "react-router-dom";
import "./styles.css";
import { ItemsPage } from "./pages/Items.js";
import { SubscriptionsPage } from "./pages/Subscriptions.js";
import { AddPage } from "./pages/Add.js";
import { SetupPage } from "./pages/Setup.js";
import { SubscriptionPage } from "./pages/Subscription.js";
import { RunPage } from "./pages/Run.js";
import { ConfigPage } from "./pages/Config.js";
import { SetsNav, SetsPage, SetPage } from "./pages/Sets.js";

function App() {
  return (
    <div className="app">
      <nav className="side">
        <h1>Web Subscriber</h1>
        <NavLink to="/" end>
          新着
        </NavLink>
        <NavLink to="/subscriptions">購読先</NavLink>
        <NavLink to="/add">購読を追加</NavLink>
        <SetsNav />
      </nav>
      <main>
        <Routes>
          <Route path="/" element={<ItemsPage />} />
          <Route path="/subscriptions" element={<SubscriptionsPage />} />
          <Route path="/subscriptions/:id" element={<SubscriptionPage />} />
          <Route path="/add" element={<AddPage />} />
          <Route path="/setup/:id" element={<SetupPage />} />
          <Route path="/runs/:id" element={<RunPage />} />
          <Route path="/configs/:id" element={<ConfigPage />} />
          <Route path="/sets" element={<SetsPage />} />
          <Route path="/sets/:id" element={<SetPage />} />
        </Routes>
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
