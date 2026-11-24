import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ArrowLeft,
  Copy,
  DotsSixVertical as GripVertical,
  MagnifyingGlass as Search,
  PencilSimple as Pencil,
  Plus,
  Trash as Trash2,
  UploadSimple as FileUp,
} from "@phosphor-icons/react";
import { toast } from "sonner";
import { AppShell } from "@/components/app-shell";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  apiJson,
  ApiError,
  VALIDATOR_OPTIONS,
  type BrandingDto,
  type ItemKind,
  type SessionResponse,
  type TemplateDto,
  type TemplateItemSpec,
  type ValidatorKey,
} from "@/lib/api";
import { brandStyle } from "@/lib/brand";

interface EditableItem extends TemplateItemSpec {
  uid: string;
}

const FILE_GROUP_OPTIONS = [
  { key: "pdf", label: "PDF" },
  { key: "image", label: "Images" },
  { key: "spreadsheet", label: "CSV / XLSX" },
  { key: "document", label: "DOCX / TXT" },
];

function makeUid() {
  return `itm_${Math.random().toString(36).slice(2, 10)}`;
}

function SortableBuilderItem({
  item,
  onChange,
  onRemove,
}: {
  item: EditableItem;
  onChange: (patch: Partial<EditableItem>) => void;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.uid,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const groups = item.allowedGroups ?? ["pdf", "image"];

  function toggleGroup(groupKey: string) {
    const next = groups.includes(groupKey)
      ? groups.filter((g) => g !== groupKey)
      : [...groups, groupKey];
    onChange({ allowedGroups: next.length > 0 ? next : [groupKey] });
  }

  return (
    <Card
      ref={setNodeRef}
      style={style}
      className={`paper-shadow border-border bg-card transition-shadow ${
        isDragging ? "relative z-10 opacity-85 shadow-md ring-2 ring-primary/40" : ""
      }`}
    >
      <CardContent className="space-y-3.5 p-4">
        <div className="flex items-start gap-2.5">
          <button
            type="button"
            className="mt-1.5 cursor-grab touch-none rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground active:cursor-grabbing"
            aria-label="Drag to reorder"
            {...attributes}
            {...listeners}
          >
            <GripVertical className="size-4" />
          </button>

          <div className="grid flex-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor={`${item.uid}-label`} className="text-xs text-muted-foreground">
                Item label
              </Label>
              <Input
                id={`${item.uid}-label`}
                value={item.label}
                placeholder="e.g. Supplier Tax Invoice PDF"
                onChange={(e) => onChange({ label: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${item.uid}-section`} className="text-xs text-muted-foreground">
                Section group
              </Label>
              <Input
                id={`${item.uid}-section`}
                value={item.section}
                placeholder="General"
                onChange={(e) => onChange({ section: e.target.value })}
              />
            </div>
          </div>

          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="mt-5 size-8 text-muted-foreground hover:text-destructive"
            onClick={onRemove}
            title="Remove item"
            aria-label="Remove item"
          >
            <Trash2 className="size-4" />
          </Button>
        </div>

        <div className="grid gap-3 pl-8 sm:grid-cols-3">
          <div className="space-y-1">
            <Label htmlFor={`${item.uid}-kind`} className="text-xs text-muted-foreground">
              Field type
            </Label>
            <Select
              value={item.kind}
              onValueChange={(val) =>
                onChange({
                  kind: val as ItemKind,
                  validator: val === "file" || val === "checkbox" ? "none" : item.validator,
                })
              }
            >
              <SelectTrigger id={`${item.uid}-kind`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="file">File upload</SelectItem>
                <SelectItem value="text">Short text / ID</SelectItem>
                <SelectItem value="textarea">Long text notes</SelectItem>
                <SelectItem value="checkbox">Declaration checkbox</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {(item.kind === "text" || item.kind === "textarea") && (
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor={`${item.uid}-validator`} className="text-xs text-muted-foreground">
                Deterministic validator
              </Label>
              <Select
                value={item.validator}
                onValueChange={(val) => onChange({ validator: val as ValidatorKey })}
              >
                <SelectTrigger id={`${item.uid}-validator`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {VALIDATOR_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {item.kind === "file" && (
            <div className="space-y-1 sm:col-span-2">
              <Label className="text-xs text-muted-foreground">Allowed formats & max size</Label>
              <div className="flex flex-wrap items-center gap-1.5">
                {FILE_GROUP_OPTIONS.map((g) => {
                  const active = groups.includes(g.key);
                  return (
                    <button
                      key={g.key}
                      type="button"
                      aria-pressed={active}
                      onClick={() => toggleGroup(g.key)}
                      className={`rounded-md border px-2 py-1 text-xs font-medium transition-colors ${
                        active
                          ? "border-primary bg-accent text-accent-foreground"
                          : "border-border bg-background text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {g.label}
                    </button>
                  );
                })}
                <Select
                  value={String(item.maxFileMb ?? 20)}
                  onValueChange={(v) => onChange({ maxFileMb: Number(v) })}
                >
                  <SelectTrigger className="h-7 w-24 text-xs" aria-label="Max file size">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="10">10 MB</SelectItem>
                    <SelectItem value="20">20 MB</SelectItem>
                    <SelectItem value="50">50 MB</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 pl-8">
          <Input
            aria-label="Helper instructions"
            value={item.helpText}
            placeholder="Helper instructions shown to client (optional)"
            className="h-8 flex-1 text-xs"
            onChange={(e) => onChange({ helpText: e.target.value })}
          />
          <div className="flex items-center gap-4">
            <label htmlFor={`${item.uid}-req`} className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Switch
                id={`${item.uid}-req`}
                checked={item.required}
                onCheckedChange={(checked) => onChange({ required: checked })}
              />
              Required
            </label>
            {item.kind === "file" && (
              <label htmlFor={`${item.uid}-mult`} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Switch
                  id={`${item.uid}-mult`}
                  checked={Boolean(item.multiple)}
                  onCheckedChange={(checked) => onChange({ multiple: checked })}
                />
                Multiple files
              </label>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function TemplatesPage({
  session,
  onSessionRefresh,
  theme,
  onToggleTheme,
}: {
  session: SessionResponse;
  onSessionRefresh: () => Promise<void>;
  theme: "light" | "dark";
  onToggleTheme: () => void;
}) {
  const navigate = useNavigate();
  const [templates, setTemplates] = useState<TemplateDto[]>([]);
  const [branding, setBranding] = useState<BrandingDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<{
    id: string | null;
    name: string;
    description: string;
    items: EditableItem[];
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TemplateDto | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const loadTemplates = useCallback(async () => {
    try {
      const res = await apiJson<{ templates: TemplateDto[]; branding?: BrandingDto }>("/api/templates");
      setTemplates(res.templates);
      if (res.branding) setBranding(res.branding);
    } catch {
      toast.error("Failed to load templates.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTemplates();
  }, [loadTemplates]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return templates;
    return templates.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q)
    );
  }, [templates, search]);

  function openNewBuilder() {
    setEditing({
      id: null,
      name: "",
      description: "",
      items: [
        {
          uid: makeUid(),
          section: "Entity Identification",
          label: "Australian Business Number (ABN)",
          helpText: "11-digit ABN verified via ATO mod-89.",
          kind: "text",
          required: true,
          validator: "au_abn_mod89",
        },
        {
          uid: makeUid(),
          section: "Supporting Documents",
          label: "Signed Engagement Letter",
          helpText: "Upload PDF copy.",
          kind: "file",
          required: true,
          validator: "none",
          allowedGroups: ["pdf"],
          maxFileMb: 20,
          multiple: false,
        },
      ],
    });
  }

  function openEditBuilder(tpl: TemplateDto) {
    setEditing({
      id: tpl.id,
      name: tpl.name,
      description: tpl.description,
      items: tpl.items.map((it) => ({ ...it, uid: makeUid() })),
    });
  }

  async function duplicateTemplate(tpl: TemplateDto) {
    setDuplicatingId(tpl.id);
    try {
      const res = await apiJson<{ template: TemplateDto }>(`/api/templates/${tpl.id}/duplicate`, {
        method: "POST",
      });
      toast.success(`Created "${res.template.name}".`);
      await loadTemplates();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not duplicate template.");
    } finally {
      setDuplicatingId(null);
    }
  }

  function handleDragEnd(event: DragEndEvent) {
    if (!editing) return;
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = editing.items.findIndex((i) => i.uid === active.id);
    const newIndex = editing.items.findIndex((i) => i.uid === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    setEditing({
      ...editing,
      items: arrayMove(editing.items, oldIndex, newIndex),
    });
  }

  async function saveTemplate() {
    if (!editing) return;
    if (!editing.name.trim()) {
      toast.error("Enter a template name.");
      return;
    }
    if (editing.items.length === 0) {
      toast.error("Add at least one checklist item.");
      return;
    }
    setSaving(true);
    try {
      const cleanItems = editing.items.map(({ uid: _uid, ...rest }) => rest);
      if (editing.id) {
        await apiJson(`/api/templates/${editing.id}`, {
          method: "PUT",
          body: JSON.stringify({
            name: editing.name,
            description: editing.description,
            items: cleanItems,
          }),
        });
        toast.success("Template updated.");
      } else {
        await apiJson("/api/templates", {
          method: "POST",
          body: JSON.stringify({
            name: editing.name,
            description: editing.description,
            items: cleanItems,
          }),
        });
        toast.success("Template created.");
      }
      setEditing(null);
      await loadTemplates();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not save template.");
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    try {
      await apiJson(`/api/templates/${deleteTarget.id}`, { method: "DELETE" });
      toast.success("Template deleted.");
      setDeleteTarget(null);
      await loadTemplates();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Cannot delete template.");
    }
  }

  const validatorShort = (key: ValidatorKey) =>
    VALIDATOR_OPTIONS.find((v) => v.value === key)?.short ?? key;

  const previewBrandName = branding?.name || session.workspace?.name || "Your practice";

  return (
    <AppShell
      session={session}
      breadcrumbs={
        editing
          ? [{ label: "Templates", to: "/templates" }, { label: editing.id ? "Edit Template" : "New Checklist Template" }]
          : [{ label: "Templates" }]
      }
      onSessionRefresh={onSessionRefresh}
      theme={theme}
      onToggleTheme={onToggleTheme}
    >
      {!editing ? (
        <div className="space-y-6">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">
                Checklist Templates
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Reusable document packs with Australian statutory validators and drag-and-drop ordering.
              </p>
            </div>
            <Button onClick={openNewBuilder}>
              <Plus className="mr-1.5 size-4" />
              New checklist template
            </Button>
          </div>

          <div className="relative max-w-sm">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
            <Input
              aria-label="Search templates"
              placeholder="Search templates..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8"
            />
          </div>

          {loading ? (
            <div className="grid gap-4 md:grid-cols-2">
              {[0, 1, 2, 3].map((idx) => (
                <Card key={idx} className="paper-shadow p-6 space-y-4">
                  <div className="space-y-2">
                    <Skeleton className="h-5 w-48" />
                    <Skeleton className="h-3.5 w-full" />
                  </div>
                  <div className="flex gap-2">
                    <Skeleton className="h-5 w-16" />
                    <Skeleton className="h-5 w-14" />
                  </div>
                  <div className="space-y-1.5 border-t border-border pt-3">
                    <Skeleton className="h-3.5 w-3/4" />
                    <Skeleton className="h-3.5 w-2/3" />
                  </div>
                </Card>
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <Card className="paper-shadow p-10 text-center">
              <p className="text-sm text-muted-foreground">No templates match your search.</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => setSearch("")}
              >
                Clear search
              </Button>
            </Card>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {filtered.map((tpl) => {
                const validators = [
                  ...new Set(tpl.items.map((i) => i.validator).filter((v) => v && v !== "none")),
                ];
                return (
                  <Card key={tpl.id} className="paper-shadow flex flex-col justify-between">
                    <CardHeader className="space-y-2">
                      <div className="flex items-start justify-between gap-2">
                        <CardTitle className="text-base font-semibold">{tpl.name}</CardTitle>
                        {tpl.is_builtin && (
                          <Badge variant="secondary" className="shrink-0 gap-1 text-[11px]">
                            Starter pack
                          </Badge>
                        )}
                      </div>
                      {tpl.description && (
                        <CardDescription className="text-xs leading-relaxed">
                          {tpl.description}
                        </CardDescription>
                      )}
                      <div className="flex flex-wrap gap-1.5 pt-1">
                        <Badge variant="outline" className="text-[11px] font-normal tabular-nums">
                          {tpl.items.length} items
                        </Badge>
                        {validators.map((v) => (
                          <Badge
                            key={v}
                            variant="outline"
                            className="border-primary/30 bg-accent/60 text-[11px] font-normal text-accent-foreground"
                          >
                            {validatorShort(v)}
                          </Badge>
                        ))}
                      </div>
                    </CardHeader>

                    <CardContent className="space-y-4">
                      <ul className="space-y-1 border-t border-border pt-3 text-xs text-muted-foreground">
                        {tpl.items.slice(0, 4).map((it, idx) => (
                          <li key={idx} className="truncate">
                            · <span className="font-medium text-foreground">{it.label}</span>{" "}
                            <span className="text-[11px]">({it.kind})</span>
                          </li>
                        ))}
                        {tpl.items.length > 4 && (
                          <li className="text-[11px] text-muted-foreground">
                            +{tpl.items.length - 4} more items
                          </li>
                        )}
                      </ul>

                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <Button
                          size="sm"
                          onClick={() => navigate(`/requests/new?templateId=${tpl.id}`)}
                        >
                          Use template
                        </Button>
                        <div className="flex items-center gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-8 px-2 text-xs"
                            onClick={() => openEditBuilder(tpl)}
                          >
                            <Pencil className="mr-1 size-3.5" />
                            Edit
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-8 px-2 text-xs"
                            disabled={duplicatingId === tpl.id}
                            onClick={() => void duplicateTemplate(tpl)}
                          >
                            <Copy className="mr-1 size-3.5" />
                            {duplicatingId === tpl.id ? "Duplicating..." : "Duplicate"}
                          </Button>
                          {!tpl.is_builtin && (
                            <Button
                              size="icon"
                              variant="ghost"
                              className="size-8 text-muted-foreground hover:text-destructive"
                              aria-label={`Delete ${tpl.name}`}
                              onClick={() => setDeleteTarget(tpl)}
                            >
                              <Trash2 className="size-3.5" />
                            </Button>
                          )}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      ) : (
        /* Visual Drag-and-Drop Template Builder + Live White-Label Client Preview */
        <div className="space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>
                <ArrowLeft className="mr-1.5 size-4" />
                Back
              </Button>
              <div>
                <h1 className="text-xl font-semibold tracking-tight">
                  {editing.id ? "Edit checklist template" : "New checklist template"}
                </h1>
                <p className="text-xs text-muted-foreground">
                  Drag items to reorder, configure Australian statutory validators, and preview the client portal before saving.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button onClick={saveTemplate} disabled={saving}>
                {saving ? "Saving..." : "Save template"}
              </Button>
            </div>
          </div>

          <div className="grid gap-6 lg:grid-cols-12">
            {/* Left: Visual Builder */}
            <div className="space-y-4 lg:col-span-7">
              <Card className="paper-shadow">
                <CardContent className="space-y-3 p-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="tpl-name">Template name</Label>
                    <Input
                      id="tpl-name"
                      placeholder="e.g. SMSF Annual Audit Pack"
                      value={editing.name}
                      onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="tpl-desc">Short description</Label>
                    <Input
                      id="tpl-desc"
                      placeholder="What this pack collects"
                      value={editing.description}
                      onChange={(e) => setEditing({ ...editing, description: e.target.value })}
                    />
                  </div>
                </CardContent>
              </Card>

              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={handleDragEnd}
              >
                <SortableContext
                  items={editing.items.map((i) => i.uid)}
                  strategy={verticalListSortingStrategy}
                >
                  <div className="space-y-3">
                    {editing.items.map((item) => (
                      <SortableBuilderItem
                        key={item.uid}
                        item={item}
                        onChange={(patch) =>
                          setEditing((prev) =>
                            prev
                              ? {
                                  ...prev,
                                  items: prev.items.map((it) =>
                                    it.uid === item.uid ? { ...it, ...patch } : it
                                  ),
                                }
                              : null
                          )
                        }
                        onRemove={() =>
                          setEditing((prev) =>
                            prev
                              ? {
                                  ...prev,
                                  items: prev.items.filter((it) => it.uid !== item.uid),
                                }
                              : null
                          )
                        }
                      />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>

              <Button
                type="button"
                variant="outline"
                className="w-full border-dashed"
                onClick={() =>
                  setEditing({
                    ...editing,
                    items: [
                      ...editing.items,
                      {
                        uid: makeUid(),
                        section: editing.items.at(-1)?.section || "General",
                        label: "New checklist item",
                        helpText: "",
                        kind: "file",
                        required: true,
                        validator: "none",
                        allowedGroups: ["pdf", "image"],
                        maxFileMb: 20,
                        multiple: false,
                      },
                    ],
                  })
                }
              >
                <Plus className="mr-1.5 size-4" />
                Add checklist item
              </Button>
            </div>

            {/* Right: Live Miniature Client Portal Preview (white-label aware) */}
            <div className="lg:col-span-5">
              <div
                style={brandStyle(branding?.brandColor)}
                className="light sticky top-20 overflow-hidden rounded-xl border border-border bg-background text-foreground paper-shadow"
              >
                <div className="flex items-center justify-between gap-2 border-b border-border bg-card px-4 py-3">
                  <div className="flex min-w-0 items-center gap-2.5">
                    {branding?.logoDataUrl ? (
                      <img
                        src={branding.logoDataUrl}
                        alt=""
                        className="h-6 max-w-[120px] object-contain"
                      />
                    ) : (
                      <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary text-[11px] font-semibold text-primary-foreground">
                        {previewBrandName.charAt(0).toUpperCase()}
                      </span>
                    )}
                    <span className="truncate text-[13px] font-semibold tracking-tight">
                      {previewBrandName}
                    </span>
                  </div>
                  <Badge variant="outline" className="shrink-0 bg-card text-[10px] text-primary">
                    Passwordless
                  </Badge>
                </div>

                <div className="p-4">
                  <div className="border-b border-border pb-3">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Live Client Portal Preview
                    </p>
                    <p className="font-display text-sm font-semibold">
                      {editing.name || "Untitled Checklist"}
                    </p>
                    <div className="mt-2 flex items-center gap-2">
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                        <div className="h-full w-1/4 rounded-full bg-primary" />
                      </div>
                      <span className="text-[11px] tabular-nums text-muted-foreground">
                        0 of {editing.items.length} done
                      </span>
                    </div>
                  </div>

                  <div className="mt-3 max-h-[58vh] space-y-2.5 overflow-y-auto pr-1">
                    {editing.items.map((item) => (
                      <div
                        key={item.uid}
                        className="rounded-lg border border-border bg-card p-3.5 text-xs"
                      >
                        <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                          {item.section || "General"}
                        </p>
                        <p className="mt-0.5 font-medium text-foreground">
                          {item.label || "Untitled item"}
                          {item.required && <span className="ml-1 text-destructive">*</span>}
                        </p>
                        {item.helpText && (
                          <p className="mt-0.5 text-[11px] text-muted-foreground">{item.helpText}</p>
                        )}
                        <div className="mt-2.5">
                          {item.kind === "file" ? (
                            <div className="flex items-center justify-center gap-1.5 rounded-md border border-dashed border-input bg-accent/50 py-3 text-[11px] text-muted-foreground">
                              <FileUp className="size-3.5 text-primary" />
                              <span>
                                Drop {(item.allowedGroups ?? ["pdf"]).join("/").toUpperCase()} · max{" "}
                                {item.maxFileMb ?? 20} MB
                              </span>
                            </div>
                          ) : item.kind === "checkbox" ? (
                            <div className="flex items-center gap-2 text-[11px] text-foreground">
                              <span className="inline-block size-3.5 rounded border border-input bg-background" />
                              <span>I confirm this declaration</span>
                            </div>
                          ) : (
                            <div className="rounded-md border border-input bg-background px-2.5 py-1.5 text-[11px] text-muted-foreground">
                              {VALIDATOR_OPTIONS.find((v) => v.value === item.validator)?.hint ||
                                "Client response..."}
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>

                  {(branding?.supportEmail || branding?.supportPhone) && (
                    <div className="mt-3 border-t border-border pt-2.5 text-[11px] text-muted-foreground">
                      Need help?{" "}
                      {[branding.supportEmail, branding.supportPhone].filter(Boolean).join(" · ")}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      <AlertDialog open={Boolean(deleteTarget)} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete template?</AlertDialogTitle>
            <AlertDialogDescription>
              "{deleteTarget?.name}" will be removed. Existing client requests created from this template are unaffected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppShell>
  );
}
