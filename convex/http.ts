import { httpRouter } from "convex/server";
import { Webhook } from "svix";
import { api } from "./_generated/api";
import { httpAction } from "./_generated/server";

const http = httpRouter();

http.route({
  path: "/clerk-webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const webhookSecret = process.env.CLERK_WEBHOOK_SECRET;
    if (!webhookSecret) {
      throw new Error("Missing webhook secret");
    }

    // Grab headers
    const svix_id = request.headers.get("svix-id");
    const svix_signature = request.headers.get("svix-signature");
    const svix_timestamp = request.headers.get("svix-timestamp");
    if (!svix_id || !svix_signature || !svix_timestamp) {
      return new Response("Missing svix headers", { status: 400 });
    }

    // IMPORTANT: verify against the raw body
    const body = await request.text();

    const wh = new Webhook(webhookSecret);
    let evt: any;
    try {
      evt = wh.verify(body, {
        "svix-id": svix_id,
        "svix-signature": svix_signature,
        "svix-timestamp": svix_timestamp,
      });
    } catch (error) {
      console.error("Error verifying webhook:", error);
      return new Response("Invalid webhook", { status: 400 });
    }

    // Parse JSON *after* verification
    const parsed = JSON.parse(body);
    const eventType = evt.type ?? parsed.type;

    if (eventType === "user.created" || eventType === "user.updated") {
      // Clerk shape: data.email_addresses (array), data.primary_email_address_id
      const {
        id,
        first_name,
        last_name,
        image_url,
        email_addresses,
        primary_email_address_id,
        username: clerkUsername,
      } = evt.data || {};

      const emails: string[] =
        (email_addresses ?? [])
          .map((e: any) => e?.email_address)
          .filter(Boolean) || [];

      let email = emails[0] || null;
      if (primary_email_address_id && email_addresses?.length) {
        const primary = email_addresses.find(
          (e: any) => e.id === primary_email_address_id
        );
        if (primary?.email_address) email = primary.email_address;
      }

      const name = `${first_name || ""} ${last_name || ""}`.trim();

      if (!email) {
        console.warn("No email found on Clerk user payload:", { id });
        return new Response("No email on user", { status: 400 });
      }

      try {
        await ctx.runMutation(api.users.createUser, {
          email,
          fullname: name || email.split("@")[0],
          image: image_url || undefined,
          clerkId: id,
          username: clerkUsername || email.split("@")[0],
        });
      } catch (error) {
        console.error("Error creating/updating user:", error);
        return new Response("Error creating user", { status: 500 });
      }
    }

    // Optionally handle deletions
    // if (eventType === "user.deleted") { ... }

    return new Response("Webhook processed successfully", { status: 200 });
  }),
});

export default http;
