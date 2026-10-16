import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { ToastProvider } from "./ui/toast";
import { TooltipProvider } from "./ui/tooltip";

createRoot(document.getElementById("root")!).render(
  <ToastProvider position="bottom-right">
    <TooltipProvider delay={400}>
      <App />
    </TooltipProvider>
  </ToastProvider>,
);
