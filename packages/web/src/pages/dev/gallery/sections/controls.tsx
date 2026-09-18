import { useState } from "react";
import { ArrowRight, Check, Plus, Search, Sparkles, Star, Trash2 } from "lucide-react";
import { Toggle } from "@rome-os/ui/toggle";
import { Calendar } from "@rome-os/ui/calendar";
import { Button } from "@/components/ui/button";
import { ButtonGroup, ButtonGroupSeparator, ButtonGroupText } from "@/components/ui/button-group";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldGroupLabel,
  FieldLabel,
} from "@/components/ui/field";
import { Component, Item, Row, Section, Specimen } from "../kit";

const BUTTON_VARIANTS = [
  "default",
  "outline",
  "secondary",
  "ghost",
  "destructive",
  "link",
] as const;

const BUTTON_SIZES = ["xs", "sm", "md"] as const;

const ICON_SIZES = ["icon-xs", "icon-sm", "icon-md", "icon-lg"] as const;

const DENSITY = [
  { value: "compact", label: "Compact" },
  { value: "cozy", label: "Cozy" },
];

export function ControlsSection() {
  const [pushEnabled, setPushEnabled] = useState(true);
  const [digest, setDigest] = useState(true);
  const [access, setAccess] = useState("private");
  const [model, setModel] = useState("opus");
  const [autoStart, setAutoStart] = useState(true);
  const [starredOnly, setStarredOnly] = useState(false);
  const [density, setDensity] = useState("cozy");
  const [calendarDate, setCalendarDate] = useState<Date | undefined>(new Date(2026, 7, 15));

  return (
    <Section
      id="controls"
      title="Controls"
      description="Primitives and composites that take input. Core controls use the --control-* / --field-* scale, so a button and a field on the same row agree."
    >
      <Component id="button" name="Button" source="@rome-os/ui/button">
        <Specimen label="Button — variants" note="One primary action per screen.">
          <Row>
            {BUTTON_VARIANTS.map((variant) => (
              <Item key={variant} label={variant}>
                <Button variant={variant}>Brief the bookkeeper</Button>
              </Item>
            ))}
          </Row>
        </Specimen>

        <Specimen
          label="Button — sizes"
          note="sm / md / lg are the 28 / 32 / 44px scale steps, and mean the same height on every control. xs sits deliberately below the scale, for dense toolbars."
        >
          <Row className="items-end">
            {BUTTON_SIZES.map((size) => (
              <Item key={size} label={size}>
                <Button size={size}>Hire an app</Button>
              </Item>
            ))}
          </Row>
        </Specimen>

        <Specimen
          label="Button — alignment"
          note="`align` picks the padding group: a centred label reads --control-px-center-*, a label on the start edge reads --control-px-start-*. The two agree at sm and the centre group sits wider at md and lg, so the md column is where the difference shows. Each button is w-56 so the alignment, not the label, sets the box."
        >
          <Row className="items-end">
            {(["sm", "md"] as const).map((size) => (
              <Item key={size} label={`${size} — centred`}>
                <Button size={size} variant="outline" className="w-56">
                  Hire an app
                </Button>
              </Item>
            ))}
            {(["sm", "md"] as const).map((size) => (
              <Item key={size} label={`${size} — start`}>
                <Button size={size} variant="outline" align="start" className="w-56">
                  Hire an app
                </Button>
              </Item>
            ))}
            <Item label="md — between">
              <Button size="md" variant="outline" align="between" className="w-56">
                Hire an app
                <ArrowRight data-icon="inline-end" />
              </Button>
            </Item>
          </Row>
        </Specimen>

        <Specimen label="Button — with icons and states">
          <Row>
            <Item label="leading icon">
              <Button>
                <Plus data-icon="inline-start" />
                Add app
              </Button>
            </Item>
            <Item label="trailing icon">
              <Button variant="outline">
                Continue
                <ArrowRight data-icon="inline-end" />
              </Button>
            </Item>
            <Item label="disabled">
              <Button disabled>Filed</Button>
            </Item>
            <Item label="aria-invalid">
              <Button variant="outline" aria-invalid>
                Needs attention
              </Button>
            </Item>
          </Row>
        </Specimen>

        <Specimen
          label="Button — shape"
          note="`shape` only swaps the radius; height, padding and type still come from `size`. On an icon size it yields a circle."
        >
          <Row className="items-end">
            {BUTTON_SIZES.map((size) => (
              <Item key={size} label={size}>
                <Button size={size} shape="pill">
                  Hire an app
                </Button>
              </Item>
            ))}
            <Item label="icon-sm">
              <Button size="icon-sm" shape="pill" variant="outline" aria-label="Delete">
                <Trash2 />
              </Button>
            </Item>
          </Row>
        </Specimen>

        <Specimen label="Button — icon only">
          <Row className="items-end">
            {ICON_SIZES.map((size) => (
              <Item key={size} label={size}>
                <Button size={size} variant="outline" aria-label="Delete">
                  <Trash2 />
                </Button>
              </Item>
            ))}
          </Row>
        </Specimen>
      </Component>

      <Component id="icon-button" name="IconButton" source="@rome-os/ui/icon-button">
        <Specimen
          label="IconButton"
          note="The shared control scale, square: the same step as a `Button` or field of the same name, so a toolbar mixing them lines up. `xs` (24px) is the exception — a row action, at the WCAG 2.5.8 minimum."
        >
          <Row className="items-end">
            <Item label="xs — 24px">
              <IconButton size="xs" label="Search" icon={<Search />} />
            </Item>
            <Item label="sm — 28px">
              <IconButton size="sm" label="Search" icon={<Search />} />
            </Item>
            <Item label="md — 32px">
              <IconButton size="md" label="Search" icon={<Search />} />
            </Item>
            <Item label="lg — 44px">
              <IconButton size="lg" label="Search" icon={<Search />} />
            </Item>
            <Item label="disabled">
              <IconButton size="md" label="Search" icon={<Search />} disabled />
            </Item>
          </Row>
        </Specimen>

        <Specimen
          label="IconButton — against Button's square variant"
          note="Value-identical at every shared step. Reach for `IconButton` by default: its required `label` makes an icon-only control accessible by construction."
        >
          <Row className="items-end">
            {(["sm", "md", "lg"] as const).map((size) => (
              <Item key={size} label={size}>
                <Row className="items-center">
                  <IconButton size={size} label="Search" icon={<Search />} />
                  <Button size={`icon-${size}`} variant="outline" aria-label="Delete">
                    <Trash2 />
                  </Button>
                </Row>
              </Item>
            ))}
          </Row>
        </Specimen>
      </Component>

      <Component id="button-group" name="ButtonGroup" source="ui/button-group.tsx">
        <Specimen
          label="ButtonGroup"
          note="Adjacent actions sharing one outline; separators and inline text are group children."
        >
          <Row>
            <ButtonGroup>
              <Button variant="outline">Day</Button>
              <Button variant="outline">Week</Button>
              <Button variant="outline">Month</Button>
            </ButtonGroup>
            <ButtonGroup>
              <ButtonGroupText>Range</ButtonGroupText>
              <ButtonGroupSeparator />
              <Button variant="outline">
                Last 7 days
                <ArrowRight data-icon="inline-end" />
              </Button>
            </ButtonGroup>
          </Row>
        </Specimen>
      </Component>

      <Component id="input" name="Input" source="@rome-os/ui/input">
        <Specimen label="Input" note="32px tall at md, 12px inner padding, 14px type.">
          <div className="grid max-w-xl gap-3">
            <Input placeholder="Search title, app, agent, or ID" />
            <Input defaultValue="A filled field" />
            <Input placeholder="Disabled" disabled />
            <Input defaultValue="Invalid value" aria-invalid />
            <Input type="password" defaultValue="hunter2000" />
          </div>
        </Specimen>

        <Specimen
          label="Input — sizes"
          note="sm and md are the whole shared vocabulary: the same 28 / 32px steps a Button or Select of the same name takes, so a mixed row needs no adjustment. There is no field at 44px — that step serves standalone calls to action, which no field joins."
        >
          <div className="grid max-w-xl gap-3">
            {(["sm", "md"] as const).map((size) => (
              // A plain flex row with `items-center` and nothing else — the
              // point of the specimen is that the row needs no adjustment.
              <div key={size} className="flex items-center gap-2">
                <div className="w-64">
                  <Input size={size} placeholder={`size="${size}"`} />
                </div>
                <Button size={size}>Add</Button>
                <SelectSpecimen size={size} />
              </div>
            ))}
          </div>
        </Specimen>

        <Specimen
          label="Input — leading glyph"
          note="The glyph rides the size axis with the rest of the row: 14px at sm, 16px at md, the same steps the Button and Select beside it take. Its inset comes from the field's own padding, so the label starts one glyph plus one control gap past the edge."
        >
          <div className="grid max-w-xl gap-3">
            {(["sm", "md"] as const).map((size) => (
              <div key={size} className="flex items-center gap-2">
                <div className="w-64">
                  <Input size={size} icon={<Search aria-hidden />} placeholder={`size="${size}"`} />
                </div>
                <Button size={size}>
                  <Search aria-hidden />
                  Search
                </Button>
              </div>
            ))}
          </div>
        </Specimen>

        <Specimen
          label="Input — plain"
          note="A field inside a surface that already frames it: no border, radius, fill or hover of its own, with the surface's edge as the frame. CommandInput is built on it. Focus stays unless the surface holds focus for its whole life, as a command palette does."
        >
          <div className="max-w-xl overflow-hidden rounded-12 border border-border bg-popover">
            <div className="border-b border-border">
              <Input variant="plain" icon={<Search aria-hidden />} placeholder="Search apps" />
            </div>
            <p className="px-3 py-2 text-ui text-muted-foreground">Results would list here.</p>
          </div>
        </Specimen>
      </Component>

      <Component id="textarea" name="Textarea" source="@rome-os/ui/textarea">
        <Specimen label="Textarea" note="The one control that pads vertically.">
          <div className="grid max-w-xl gap-3">
            <Textarea placeholder="What should the bookkeeper handle this week?" />
            <Textarea defaultValue="Disabled" disabled />
            <Textarea defaultValue="Invalid" aria-invalid />
          </div>
        </Specimen>
      </Component>

      <Component id="select" name="Select" source="ui/select.tsx">
        <Specimen label="Select" note="Shares its height and radius with Button and Input.">
          <Row className="items-end">
            <Item label="default (32px)">
              <Select value={model} onValueChange={setModel}>
                <SelectTrigger className="w-48" aria-label="Model">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="opus">Opus</SelectItem>
                  <SelectItem value="sonnet">Sonnet</SelectItem>
                  <SelectItem value="haiku">Haiku</SelectItem>
                </SelectContent>
              </Select>
            </Item>
            <Item label="sm (28px)">
              <Select value={model} onValueChange={setModel}>
                <SelectTrigger size="sm" className="w-40" aria-label="Model, small">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="opus">Opus</SelectItem>
                  <SelectItem value="sonnet">Sonnet</SelectItem>
                  <SelectItem value="haiku">Haiku</SelectItem>
                </SelectContent>
              </Select>
            </Item>
            <Item label="disabled">
              <Select disabled value={model}>
                <SelectTrigger className="w-40" aria-label="Model, disabled">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="opus">Opus</SelectItem>
                </SelectContent>
              </Select>
            </Item>
          </Row>
        </Specimen>
      </Component>

      <Component id="calendar" name="Calendar" source="@rome-os/ui/calendar">
        <Specimen
          label="Calendar — single date"
          note="The date grid keeps its compact 28px cell geometry."
        >
          <Calendar mode="single" selected={calendarDate} onSelect={setCalendarDate} />
        </Specimen>

        <Specimen
          label="Calendar — dropdown caption"
          note="Month and year become dropdowns. Their caption chevron is the same Chevron component the nav arrows use, sized by the row that holds it rather than by itself — 14px in the caption, the Button step in the nav."
        >
          <Calendar
            mode="single"
            captionLayout="dropdown"
            selected={calendarDate}
            onSelect={setCalendarDate}
          />
        </Specimen>
      </Component>

      <Component id="switch" name="Switch" source="@rome-os/ui/switch">
        <Specimen label="Switch">
          <Row>
            <Item label="on">
              <Switch checked={pushEnabled} onCheckedChange={setPushEnabled} aria-label="Push" />
            </Item>
            <Item label="off">
              <Switch checked={false} aria-label="Push, off" />
            </Item>
            <Item label="disabled">
              <Switch checked disabled aria-label="Push, disabled" />
            </Item>
          </Row>
        </Specimen>
      </Component>

      <Component id="checkbox" name="Checkbox" source="@rome-os/ui/checkbox">
        <Specimen
          label="Checkbox"
          note="A yes/no in a form, or one pick where any number may be on. Switch is for a value that takes effect at once. 16px, off the control scale; the hit area reaches past the box."
        >
          <Row>
            <Item label="off">
              <Checkbox checked={false} aria-label="Digest, off" />
            </Item>
            <Item label="on">
              <Checkbox
                checked={digest}
                onCheckedChange={(next) => setDigest(next === true)}
                aria-label="Digest"
              />
            </Item>
            <Item label="mixed">
              <Checkbox checked="indeterminate" aria-label="Select all, mixed" />
            </Item>
            <Item label="disabled">
              <Checkbox checked disabled aria-label="Digest, disabled" />
            </Item>
            <Item label="with label">
              <label
                htmlFor="gallery-checkbox-labelled"
                className="flex items-center gap-2 text-ui text-foreground"
              >
                <Checkbox id="gallery-checkbox-labelled" defaultChecked />
                Email me a summary
              </label>
            </Item>
          </Row>
        </Specimen>
      </Component>

      <Component id="radio-group" name="RadioGroup" source="@rome-os/ui/radio-group">
        <Specimen
          label="RadioGroup"
          note="One pick from a short set that all show. SegmentedControl switches a view; this sets a value. Radix supplies the arrow-key movement a row of role=radio buttons lacks."
        >
          <RadioGroup aria-label="Access" value={access} onValueChange={setAccess}>
            {[
              { value: "private", label: "Private", hint: "Only you" },
              { value: "public", label: "Public", hint: "Anyone with the link" },
              { value: "email", label: "By email", hint: "People you list" },
            ].map((option) => (
              <label
                key={option.value}
                htmlFor={`gallery-radio-${option.value}`}
                className="flex items-start gap-3 text-ui text-foreground"
              >
                <span className="flex h-5 items-center">
                  <RadioGroupItem id={`gallery-radio-${option.value}`} value={option.value} />
                </span>
                <span>
                  <span className="block">{option.label}</span>
                  <span className="block text-aux text-muted-foreground">{option.hint}</span>
                </span>
              </label>
            ))}
          </RadioGroup>
        </Specimen>
      </Component>

      <Component id="toggle" name="Toggle" source="@rome-os/ui/toggle">
        <Specimen
          label="Toggle — pressed and unpressed"
          note="A button that stays pressed. Switch is the form control; this is the toolbar one."
        >
          <Row>
            <Item label="ghost — off">
              <Toggle pressed={false} onPressedChange={() => {}}>
                Auto-start
              </Toggle>
            </Item>
            <Item label="ghost — on">
              <Toggle pressed onPressedChange={() => {}}>
                Auto-start
              </Toggle>
            </Item>
            <Item label="outline — off">
              <Toggle variant="outline" pressed={false} onPressedChange={() => {}}>
                Auto-start
              </Toggle>
            </Item>
            <Item label="outline — on">
              <Toggle variant="outline" pressed onPressedChange={() => {}}>
                Auto-start
              </Toggle>
            </Item>
            <Item label="disabled — on">
              <Toggle pressed onPressedChange={() => {}} disabled>
                Auto-start
              </Toggle>
            </Item>
          </Row>
        </Specimen>

        <Specimen
          label="Toggle — live, with icons"
          note="Icon-only sizes take Button's icon steps; every size takes Button's geometry."
        >
          <Row className="items-end">
            <Item label="default">
              <Toggle pressed={autoStart} onPressedChange={setAutoStart}>
                <Sparkles data-icon="inline-start" />
                Auto-start ready tickets
              </Toggle>
            </Item>
            <Item label="icon-sm">
              <Toggle
                size="icon-sm"
                variant="outline"
                aria-label="Starred only"
                pressed={starredOnly}
                onPressedChange={setStarredOnly}
              >
                <Star />
              </Toggle>
            </Item>
            <Item label="icon">
              <Toggle
                size="icon-md"
                variant="outline"
                aria-label="Starred only, medium"
                pressed={starredOnly}
                onPressedChange={setStarredOnly}
              >
                <Star />
              </Toggle>
            </Item>
          </Row>
        </Specimen>

        <Specimen
          label="Toggle — on a toolbar row"
          note="Toggle, Button and SegmentedControl share the --control-* scale, so a row of them agrees at every step."
        >
          <div className="grid gap-3">
            <Row className="items-center">
              <Toggle size="sm" pressed={autoStart} onPressedChange={setAutoStart}>
                Auto-start
              </Toggle>
              <Button size="sm" variant="outline">
                Refresh
              </Button>
              <SegmentedControl
                size="sm"
                aria-label="Board density, small"
                options={DENSITY}
                value={density}
                onValueChange={setDensity}
              />
            </Row>
            <Row className="items-center">
              <Toggle pressed={autoStart} onPressedChange={setAutoStart}>
                Auto-start
              </Toggle>
              <Button variant="outline">Refresh</Button>
              <SegmentedControl
                aria-label="Board density"
                options={DENSITY}
                value={density}
                onValueChange={setDensity}
              />
            </Row>
          </div>
        </Specimen>
      </Component>

      <Component id="field" name="Field" source="@rome-os/ui/field">
        <Specimen
          label="Field"
          note="Form-library-agnostic label / description / error primitives."
        >
          <FieldGroup className="max-w-xl">
            <Field>
              <FieldLabel htmlFor="gallery-business">Business name</FieldLabel>
              <Input id="gallery-business" defaultValue="Ash & Oak Bakery" />
              <FieldDescription>Shown on invoices and outbound email.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="gallery-vat">VAT number</FieldLabel>
              <Input id="gallery-vat" defaultValue="not-a-vat-number" aria-invalid />
              <FieldError errors={["That doesn't look like a VAT number."]} />
            </Field>
            <Field>
              <FieldGroupLabel id="gallery-crust">Crust</FieldGroupLabel>
              <div role="group" aria-labelledby="gallery-crust" className="flex gap-2">
                <Button variant="secondary">Sourdough</Button>
                <Button variant="secondary">Rye</Button>
              </div>
            </Field>
            <Field>
              <Row>
                <Button>
                  <Check data-icon="inline-start" />
                  Save
                </Button>
                <Button variant="ghost">Cancel</Button>
              </Row>
            </Field>
          </FieldGroup>
        </Specimen>
      </Component>
    </Section>
  );
}

/** The Select half of the size-agreement row, kept out of the map for width. */
function SelectSpecimen({ size }: { size: "sm" | "md" }) {
  return (
    <Select defaultValue="opus">
      <SelectTrigger size={size} aria-label={`Model, ${size}`}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="opus">Opus</SelectItem>
        <SelectItem value="sonnet">Sonnet</SelectItem>
      </SelectContent>
    </Select>
  );
}
