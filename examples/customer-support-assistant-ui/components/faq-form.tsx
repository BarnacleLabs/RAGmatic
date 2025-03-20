"use client";

import type React from "react";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertCircle, Save, Loader2 } from "lucide-react";
import { createFaq, updateFaq } from "@/lib/actions/faqs";
import type { Faq } from "@/lib/db/schema/faqs";

interface FaqFormProps {
  faq?: Faq;
  onSuccess?: () => void;
}

export function FaqForm({ faq, onSuccess }: FaqFormProps = {}) {
  const router = useRouter();
  const [title, setTitle] = useState(faq?.title || "");
  const [content, setContent] = useState(faq?.content || "");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError("");

    try {
      if (!title.trim() || !content.trim()) {
        throw new Error("Title and content are required");
      }

      if (faq?.id) {
        await updateFaq(faq.id, { title, content });
      } else {
        await createFaq({ title, content });
      }

      // Reset form if creating new FAQ
      if (!faq) {
        setTitle("");
        setContent("");
      }

      router.refresh();
      if (onSuccess) onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4 py-2">
      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="space-y-2">
        <label
          htmlFor="title"
          className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
        >
          Title
        </label>
        <Input
          id="title"
          placeholder="Enter FAQ title..."
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="w-full font-medium"
        />
      </div>

      <div className="space-y-2">
        <label
          htmlFor="content"
          className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
        >
          Content
        </label>
        <Textarea
          id="content"
          placeholder="Enter detailed answer..."
          value={content}
          onChange={(e) => setContent(e.target.value)}
          className="min-h-[180px] w-full resize-none"
        />
      </div>

      <div className="flex justify-end gap-3 pt-2">
        <Button type="submit" disabled={isSubmitting} className="gap-2">
          {isSubmitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>{faq ? "Updating..." : "Creating..."}</span>
            </>
          ) : (
            <>
              <Save className="h-4 w-4" />
              <span>{faq ? "Update FAQ" : "Create FAQ"}</span>
            </>
          )}
        </Button>
      </div>
    </form>
  );
}
