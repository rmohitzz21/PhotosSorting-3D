import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { db } from "./database";
import {
  ConnectPhotos,
  GoogleUnavailable,
  pickerScope,
} from "./picker-protocol";

function key() {
  if (!process.env.AUTH_SECRET) throw Error("Missing authentication secret");
  return createHash("sha256")
    .update("shoebox/picker/v1\0" + process.env.AUTH_SECRET)
    .digest();
}
function seal(user: string, value: string) {
  const nonce = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key(), nonce);
  cipher.setAAD(Buffer.from(user));
  return Buffer.concat([
    nonce,
    cipher.update(value, "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64");
}
function open(user: string, encoded: string) {
  const b = Buffer.from(encoded, "base64"),
    cipher = createDecipheriv("aes-256-gcm", key(), b.subarray(0, 12));
  cipher.setAAD(Buffer.from(user));
  cipher.setAuthTag(b.subarray(-16));
  return Buffer.concat([
    cipher.update(b.subarray(12, -16)),
    cipher.final(),
  ]).toString("utf8");
}
export async function saveGrant(
  user: string,
  access: string,
  expires: number,
  refresh?: string,
) {
  const sql = db();
  await sql.transaction([
    sql`insert into users(id) values(${user}) on conflict do nothing`,
    sql`insert into photo_connections(owner,access_enc,expires,refresh_enc) select id,${seal(user, access)},to_timestamp(${expires}),${refresh ? seal(user, refresh) : null} from users where id=${user} and not deleting on conflict(owner) do update set access_enc=excluded.access_enc,expires=excluded.expires,refresh_enc=coalesce(excluded.refresh_enc,photo_connections.refresh_enc)`,
    sql`insert into audit_log(owner,action) values(${user},${"scope_grant " + pickerScope})`,
  ]);
}
export async function accessToken(user: string) {
  const sql = db();
  const [row] =
    await sql`select c.* from photo_connections c join users u on u.id=c.owner where owner=${user} and not deleting`;
  if (!row) throw new ConnectPhotos();
  if (new Date(row.expires).getTime() > Date.now() + 30000)
    return open(user, row.access_enc);
  if (!row.refresh_enc) throw new ConnectPhotos();
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({
      client_id: process.env.AUTH_GOOGLE_ID!,
      client_secret: process.env.AUTH_GOOGLE_SECRET!,
      grant_type: "refresh_token",
      refresh_token: open(user, row.refresh_enc),
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(12000),
  });
  const data = await r.json();
  if (!r.ok) {
    if (data.error === "invalid_grant") {
      await sql`delete from photo_connections where owner=${user} and access_enc=${row.access_enc}`;
      throw new ConnectPhotos();
    }
    throw new GoogleUnavailable();
  }
  await sql`update photo_connections set access_enc=${seal(user, data.access_token)},expires=now()+${Number(data.expires_in)}*interval '1 second' where owner=${user} and access_enc=${row.access_enc}`;
  return String(data.access_token);
}

