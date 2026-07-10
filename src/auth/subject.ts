export type AuthMethod = "api_key" | "signed_agent" | "none";

export interface AuthContext {
  method: AuthMethod;
  authenticated_subject: string;
  claimed_nanda_id?: string;
  auth_level: "write_key" | "signed_request" | "local_dev";
  capabilities?: {
    delete_files: boolean;
  };
}

export function canonicalSubject(input: string): string {
  const subject = input.trim().toLowerCase();
  if (subject.length === 0) {
    throw new Error("Authenticated subject cannot be empty");
  }
  return subject;
}
