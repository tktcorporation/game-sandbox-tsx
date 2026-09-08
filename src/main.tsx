import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { preloadKenney } from "./assets/kenney";
import App from "./App";
import "./index.css";

preloadKenney();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
