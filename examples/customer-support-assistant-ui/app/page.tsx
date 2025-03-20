import { Suspense } from "react";
import { FaqDashboard } from "@/components/faq-dashboard";
import { AssistantModal } from "@/components/assistant-ui/assistant-modal";
import { MyRuntimeProvider } from "./MyRuntimeProvider";

export default function Home() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/30">
      <main className="container py-10 mx-auto">
        <Suspense fallback={<div>Loading...</div>}>
          <FaqDashboard />
        </Suspense>
        <div className="">
          <MyRuntimeProvider>
            <div className="flex h-full w-full items-center justify-center p-4">
              <AssistantModal />
              <p className="bold text-lg">
                The Assistant Modal is available in the bottom right corner of
                the screen.
              </p>
            </div>
          </MyRuntimeProvider>
        </div>
      </main>
    </div>
  );
}
