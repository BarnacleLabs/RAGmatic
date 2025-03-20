"use client";

import { useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { Pencil, Trash2, Info, FileQuestion } from "lucide-react";
import { FaqForm } from "./faq-form";
import { deleteFaq } from "@/lib/actions/faqs";
import { useRouter } from "next/navigation";
import type { Faq } from "@/lib/db/schema/faqs";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

interface FaqListProps {
  faqs: Faq[];
  loading: boolean;
  viewType: "list" | "grid";
  onUpdate: () => void;
}

export function FaqList({ faqs, loading, viewType, onUpdate }: FaqListProps) {
  const [editFaq, setEditFaq] = useState<Faq | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [viewFaq, setViewFaq] = useState<Faq | null>(null);
  const router = useRouter();

  const handleDelete = async (id: number) => {
    await deleteFaq(id);
    onUpdate();
    setDeleteId(null);
  };

  if (loading) {
    return (
      <div className="space-y-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="border rounded-lg p-4 space-y-3">
            <Skeleton className="h-6 w-3/4" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
          </div>
        ))}
      </div>
    );
  }

  if (faqs.length === 0 && !loading) {
    return (
      <div className="flex flex-col items-center justify-center py-12 bg-muted/30 rounded-lg border border-dashed">
        <FileQuestion className="h-16 w-16 text-muted-foreground/50 mb-4" />
        <h3 className="text-lg font-medium">No FAQs Found</h3>
        <p className="text-muted-foreground text-center max-w-sm mt-2">
          Create your first FAQ to get started by clicking the "Create FAQ"
          button above.
        </p>
      </div>
    );
  }

  // List View
  if (viewType === "list") {
    return (
      <>
        <div className="space-y-4 bg-background rounded-md shadow-sm border">
          <Accordion type="multiple" className="w-full">
            {faqs.map((faq) => (
              <AccordionItem
                key={faq.id}
                value={`item-${faq.id}`}
                className="border-b last:border-0"
              >
                <div className="flex items-center justify-between px-4">
                  <AccordionTrigger className="flex-1 text-left py-4 hover:no-underline">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{faq.title}</span>
                      <Badge variant="outline" className="ml-2 font-normal">
                        ID: {faq.id}
                      </Badge>
                    </div>
                  </AccordionTrigger>
                  <div className="flex gap-2">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditFaq(faq);
                      }}
                    >
                      <Pencil className="h-4 w-4" />
                      <span className="sr-only">Edit</span>
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeleteId(faq.id);
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                      <span className="sr-only">Delete</span>
                    </Button>
                  </div>
                </div>
                <AccordionContent className="pt-0 px-4 pb-4">
                  <div className="prose prose-sm max-w-none dark:prose-invert">
                    {faq.content}
                  </div>
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </div>

        {/* Edit Dialog */}
        <Dialog
          open={!!editFaq}
          onOpenChange={(open) => !open && setEditFaq(null)}
        >
          <DialogContent className="sm:max-w-[525px]">
            <DialogTitle className="text-2xl">Edit FAQ</DialogTitle>
            {editFaq && (
              <FaqForm
                faq={editFaq}
                onSuccess={() => {
                  onUpdate();
                  setEditFaq(null);
                }}
              />
            )}
          </DialogContent>
        </Dialog>

        {/* Delete Confirmation */}
        <AlertDialog
          open={!!deleteId}
          onOpenChange={(open) => !open && setDeleteId(null)}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Are you sure?</AlertDialogTitle>
              <AlertDialogDescription>
                This action cannot be undone. This will permanently delete the
                FAQ.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={() => deleteId && handleDelete(deleteId)}
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </>
    );
  }

  // Grid View
  return (
    <>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {faqs.map((faq) => (
          <Card
            key={faq.id}
            className="overflow-hidden hover:shadow-md transition-shadow"
          >
            <CardHeader className="pb-3">
              <CardTitle className="text-lg font-medium">{faq.title}</CardTitle>
              <Badge variant="outline" className="w-fit text-xs">
                ID: {faq.id}
              </Badge>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground line-clamp-3">
              {faq.content}
            </CardContent>
            <CardFooter className="flex justify-between border-t pt-3 pb-3 bg-muted/10">
              <Button
                variant="ghost"
                size="sm"
                className="h-8 gap-1"
                onClick={() => setViewFaq(faq)}
              >
                <Info className="h-3.5 w-3.5" />
                <span>View</span>
              </Button>
              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => setEditFaq(faq)}
                >
                  <Pencil className="h-3.5 w-3.5" />
                  <span className="sr-only">Edit</span>
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => setDeleteId(faq.id)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  <span className="sr-only">Delete</span>
                </Button>
              </div>
            </CardFooter>
          </Card>
        ))}
      </div>

      {/* View Dialog */}
      <Dialog
        open={!!viewFaq}
        onOpenChange={(open) => !open && setViewFaq(null)}
      >
        <DialogContent className="sm:max-w-[525px]">
          <DialogTitle className="text-2xl pb-2">{viewFaq?.title}</DialogTitle>
          <div className="prose dark:prose-invert prose-pre:whitespace-pre-wrap max-w-full">
            {viewFaq?.content}
          </div>
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog
        open={!!editFaq}
        onOpenChange={(open) => !open && setEditFaq(null)}
      >
        <DialogContent className="sm:max-w-[525px]">
          <DialogTitle className="text-2xl">Edit FAQ</DialogTitle>
          {editFaq && (
            <FaqForm
              faq={editFaq}
              onSuccess={() => {
                onUpdate();
                setEditFaq(null);
              }}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog
        open={!!deleteId}
        onOpenChange={(open) => !open && setDeleteId(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Are you sure?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. This will permanently delete the
              FAQ.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleteId && handleDelete(deleteId)}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
