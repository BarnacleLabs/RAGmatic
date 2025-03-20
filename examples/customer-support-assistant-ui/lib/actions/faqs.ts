"use server";

import { NewFaqParams, insertFaqSchema, faqs } from "@/lib/db/schema/faqs";
import { revalidatePath } from "next/cache";
import { desc, eq } from "drizzle-orm";
import { db } from "../db/index";

export const createFaq = async (input: NewFaqParams) => {
  try {
    const { title, content } = insertFaqSchema.parse(input);

    const [faq] = await db.insert(faqs).values({ title, content }).returning();

    revalidatePath("/");
    return { success: true };
  } catch (error) {
    console.error("Failed to create FAQ:", error);
    throw new Error("Failed to create FAQ");
  }
};

export async function getFaqs() {
  try {
    const results = await db.select().from(faqs).orderBy(desc(faqs.createdAt));
    return results.sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    );
  } catch (error) {
    console.error("Failed to fetch FAQs:", error);
    throw new Error("Failed to fetch FAQs");
  }
}

export async function getFaq(id: number) {
  try {
    const [faq] = await db.select().from(faqs).where(eq(faqs.id, id));
    if (!faq) {
      throw new Error(`FAQ with ID ${id} not found`);
    }
    return faq;
  } catch (error) {
    console.error(`Failed to fetch FAQ with ID ${id}:`, error);
    throw new Error(`Failed to fetch FAQ with ID ${id}`);
  }
}

export async function updateFaq(
  id: number,
  { title, content }: { title: string; content: string },
) {
  try {
    await db.update(faqs).set({ title, content }).where(eq(faqs.id, id));

    revalidatePath("/");
    return { success: true };
  } catch (error) {
    console.error(`Failed to update FAQ with ID ${id}:`, error);
    throw new Error(`Failed to update FAQ with ID ${id}`);
  }
}

export async function deleteFaq(id: number) {
  try {
    await db.delete(faqs).where(eq(faqs.id, id));

    revalidatePath("/");
    return { success: true };
  } catch (error) {
    console.error(`Failed to delete FAQ with ID ${id}:`, error);
    throw new Error(`Failed to delete FAQ with ID ${id}`);
  }
}
