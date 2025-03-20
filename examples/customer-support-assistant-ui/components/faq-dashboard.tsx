"use client";

import { useState, useEffect } from "react";
import { FaqList } from "@/components/faq-list";
import { FaqForm } from "@/components/faq-form";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { PlusCircle, Database, ListChecks } from "lucide-react";
import { getFaqs } from "@/lib/actions/faqs";
import type { Faq } from "@/lib/db/schema/faqs";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export function FaqDashboard() {
  const [faqs, setFaqs] = useState<Faq[]>([]);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  // Load FAQs on component mount
  useEffect(() => {
    const loadFaqs = async () => {
      try {
        const data = await getFaqs();
        setFaqs(data);
      } catch (error) {
        console.error("Error loading FAQs:", error);
      } finally {
        setLoading(false);
      }
    };

    loadFaqs();
  }, [refreshKey]);

  const refreshFaqs = () => {
    setRefreshKey((prev) => prev + 1);
  };

  return (
    <div className="space-y-8">
      <Card className="border-none shadow-md bg-card/60 backdrop-blur-sm">
        <CardHeader className="pb-4">
          <div className="flex items-start justify-between">
            <div>
              <CardTitle className="text-3xl font-bold tracking-tight">
                FAQ Manager
              </CardTitle>
              <CardDescription className="text-lg mt-1">
                Create and manage your frequently asked questions
              </CardDescription>
            </div>
            <Dialog open={formOpen} onOpenChange={setFormOpen}>
              <DialogTrigger asChild>
                <Button size="lg" className="gap-2">
                  <PlusCircle className="h-5 w-5" />
                  <span>Create FAQ</span>
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-[525px]">
                <DialogTitle className="text-2xl">Create New FAQ</DialogTitle>
                <FaqForm
                  onSuccess={() => {
                    refreshFaqs();
                    setFormOpen(false);
                  }}
                />
              </DialogContent>
            </Dialog>
          </div>
        </CardHeader>
      </Card>

      <div className="grid gap-6">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold flex items-center gap-2">
            <Database className="h-5 w-5 text-primary" />
            <span>Manage FAQ Content</span>
          </h2>
          <div className="text-sm text-muted-foreground">
            {faqs.length} {faqs.length === 1 ? "entry" : "entries"}
          </div>
        </div>

        <Tabs defaultValue="list" className="w-full">
          <TabsList className="grid w-full max-w-md grid-cols-2">
            <TabsTrigger value="list" className="flex items-center gap-2">
              <ListChecks className="h-4 w-4" />
              <span>List View</span>
            </TabsTrigger>
            <TabsTrigger value="grid" className="flex items-center gap-2">
              <Database className="h-4 w-4" />
              <span>Grid View</span>
            </TabsTrigger>
          </TabsList>
          <TabsContent value="list" className="mt-6">
            <FaqList
              faqs={faqs}
              loading={loading}
              viewType="list"
              onUpdate={refreshFaqs}
            />
          </TabsContent>
          <TabsContent value="grid" className="mt-6">
            <FaqList
              faqs={faqs}
              loading={loading}
              viewType="grid"
              onUpdate={refreshFaqs}
            />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
