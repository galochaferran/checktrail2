import { createClient } from "@/utils/supabase/server";
import { cookies } from "next/headers";

export default async function Page() {
  const cookieStore = await cookies();
  const supabase = createClient(cookieStore);

  const { data: todos } = await supabase.from("todos").select();

  return (
    <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif" }}>
      <h1>Supabase todos</h1>
      <p>
        <a href="/game.html">Open Anon Wheel game</a>
      </p>
      <ul>
        {todos?.map((todo) => (
          <li key={todo.id}>{todo.name}</li>
        ))}
      </ul>
      {!todos?.length && (
        <p style={{ color: "#666" }}>
          No rows yet — create a <code>todos</code> table in Supabase, or ignore
          this demo page and use the game link above.
        </p>
      )}
    </main>
  );
}
