import { useEffect, useState, type FormEvent } from "react";
import { CircleNotch, LockKey, UserCircle } from "@phosphor-icons/react";
import { toast } from "sonner";
import { PasswordInput } from "@/components/password-input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiJson, ApiError, type SettingsResponse } from "@/lib/api";

export function AccountSettings({
  account,
  onSaved,
}: {
  account: SettingsResponse["account"];
  onSaved: () => Promise<void>;
}) {
  const [workspaceName, setWorkspaceName] = useState(account.workspaceName);
  const [displayName, setDisplayName] = useState(account.displayName);
  const [email, setEmail] = useState(account.email);
  const [savingProfile, setSavingProfile] = useState(false);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);

  useEffect(() => {
    setWorkspaceName(account.workspaceName);
    setDisplayName(account.displayName);
    setEmail(account.email);
  }, [account]);

  async function saveProfile(e: FormEvent) {
    e.preventDefault();
    setSavingProfile(true);
    try {
      await apiJson("/api/account", {
        method: "PUT",
        body: JSON.stringify({
          workspaceName: workspaceName.trim(),
          displayName: displayName.trim(),
          email: email.trim(),
        }),
      });
      toast.success("Profile updated.");
      await onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not update profile.");
    } finally {
      setSavingProfile(false);
    }
  }

  async function changePassword(e: FormEvent) {
    e.preventDefault();
    if (newPassword.length < 10) {
      toast.error("New password must be at least 10 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error("New passwords do not match.");
      return;
    }
    setSavingPassword(true);
    try {
      await apiJson("/api/account/password", {
        method: "PUT",
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      toast.success("Password updated. Other active sessions were signed out.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not update password.");
    } finally {
      setSavingPassword(false);
    }
  }

  return (
    <div className="max-w-2xl space-y-6">
      <Card className="paper-shadow">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <UserCircle className="size-4 text-primary" />
            Practice & Account Profile
          </CardTitle>
          <CardDescription className="text-xs">
            Update your operator identity and the practice name shown to clients in portals and emails.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={saveProfile} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="account-workspace-name">Practice / Workspace name</Label>
              <Input
                id="account-workspace-name"
                value={workspaceName}
                onChange={(e) => setWorkspaceName(e.target.value)}
                maxLength={100}
                required
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="account-display-name">Display name</Label>
                <Input
                  id="account-display-name"
                  placeholder="e.g. Sarah Mitchell"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  maxLength={100}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="account-email">Sign-in email</Label>
                <Input
                  id="account-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
            </div>
            <Button type="submit" disabled={savingProfile || !workspaceName.trim() || !email.trim()}>
              {savingProfile && <CircleNotch className="size-4 animate-spin" />}
              Save profile
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card className="paper-shadow">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <LockKey className="size-4 text-primary" />
            Change Password
          </CardTitle>
          <CardDescription className="text-xs">
            Use at least 10 characters. Changing your password signs out all other active sessions.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={changePassword} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="current-password">Current password</Label>
              <PasswordInput
                id="current-password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                required
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="new-password">New password</Label>
                <PasswordInput
                  id="new-password"
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  minLength={10}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="confirm-password">Confirm new password</Label>
                <PasswordInput
                  id="confirm-password"
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  minLength={10}
                  required
                />
              </div>
            </div>
            <Button
              type="submit"
              variant="outline"
              disabled={savingPassword || !currentPassword || newPassword.length < 10 || !confirmPassword}
            >
              {savingPassword && <CircleNotch className="size-4 animate-spin" />}
              Update password
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
