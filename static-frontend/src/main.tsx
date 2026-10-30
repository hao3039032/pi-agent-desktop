import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BootPage } from "./BootPage";
import "./boot.css";

const container = document.getElementById("root");
if (container === null) throw new Error("static frontend: #root missing");

createRoot(container).render(
  <StrictMode>
    <BootPage />
  </StrictMode>,
);
