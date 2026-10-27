import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View, type GestureResponderEvent } from 'react-native'
import Svg, { Path } from 'react-native-svg'
import type { DateTimePickerProps } from '@expo/ui/community/datetime-picker'
import { showMaterialOverlay } from './MaterialOverlay'
import { useMaterialFont, useMaterialPalette } from './materialTheme'

/**
 * The Compose Material 3 date and time dialogs @expo/ui shows on Android (presentation
 * "dialog"), drawn by the app on iOS. Mounting the component opens the dialog; Set reports the
 * value like Android does (the date dialog as the chosen day at UTC midnight, the time dialog as
 * `value` with its local hour and minute replaced), Cancel or a tap outside calls onDismiss.
 */
export function DateTimePicker(props: DateTimePickerProps) {
  const latest = useRef(props)
  latest.current = props
  useEffect(() => showMaterialOverlay(close => {
    const { value, mode, accentColor, positiveButton, negativeButton, is24Hour } = latest.current
    const finish = (date: Date) => {
      close()
      latest.current.onValueChange?.({ nativeEvent: { timestamp: date.getTime(), utcOffset: -date.getTimezoneOffset() } }, date)
    }
    const dismiss = () => { close(); latest.current.onDismiss?.() }
    const shared = { value, accent: String(accentColor ?? '#74ade8'), confirmLabel: positiveButton?.label ?? 'OK', dismissLabel: negativeButton?.label ?? 'Cancel', onConfirm: finish, onDismiss: dismiss }
    return mode === 'time' ? <TimePickerDialog {...shared} is24Hour={Boolean(is24Hour)} /> : <DatePickerDialog {...shared} />
  }), [])
  return null
}

type DialogProps = { value: Date; accent: string; confirmLabel: string; dismissLabel: string; onConfirm: (date: Date) => void; onDismiss: () => void }

// Roboto's ascender sits 0.2168 em above its cap height: a Text whose caps must start at y
// starts this much higher. Positions below are where Android draws each cap or digit top; the
// `shift` values were calibrated against iOS screenshots (React Native rounds line boxes).
const capTop = (y: number, fontSize: number, shift = 0) => y - fontSize * 0.2168 + shift

const ICON = {
  edit: 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z',
  calendar: 'M9 11H7v2h2v-2zm4 0h-2v2h2v-2zm4 0h-2v2h2v-2zm2-7h-1V2h-2v2H8V2H6v2H5c-1.11 0-1.99.9-1.99 2L3 20c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V9h14v11z',
  dropDown: 'M7 10l5 5 5-5z',
  previous: 'M15.41 16.59L10.83 12l4.58-4.59L14 6l-6 6 6 6 1.41-1.41z',
  next: 'M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6-1.41-1.41z',
}

function Icon({ path, color, rotate }: { path: string; color: string; rotate?: boolean }) {
  return <Svg width={24} height={24} viewBox="0 0 24 24" style={rotate ? { transform: [{ rotate: '180deg' }] } : undefined}><Path d={path} fill={color} /></Svg>
}

/** The dialog window: 60% scrim that dismisses on tap, the card centered on screen. */
function DialogFrame({ width, height, onDismiss, children }: { width: number; height: number; onDismiss: () => void; children: ReactNode }) {
  const palette = useMaterialPalette()
  return <View style={StyleSheet.absoluteFill}>
    <Pressable accessible={false} style={[StyleSheet.absoluteFill, { backgroundColor: palette.alert.scrim }]} onPress={onDismiss} />
    <View pointerEvents="box-none" style={styles.center}>
      <View accessibilityViewIsModal style={[styles.card, { width, height, backgroundColor: palette.picker.container }]}>{children}</View>
    </View>
  </View>
}

/** M3 TextButtons at Android's measured text positions (cap top and left edge of each label). */
function DialogButtons({ top, items }: { top: number; items: Array<{ label: string; left: number; onPress: () => void }> }) {
  const palette = useMaterialPalette().picker
  const medium = useMaterialFont('Roboto-Medium')
  return <>{items.map(item => <Pressable
    key={item.label}
    accessibilityRole="button"
    accessibilityLabel={item.label}
    onPress={item.onPress}
    style={({ pressed }) => [styles.textButton, { left: item.left - 12, top: top - 14 }, pressed && { backgroundColor: palette.pressed }]}
  ><Text style={[styles.label, { color: palette.button, fontFamily: medium }]}>{item.label}</Text></Pressable>)}</>
}

const utcDay = (year: number, month: number, day: number) => new Date(Date.UTC(year, month, day))
const format = (date: Date, options: Intl.DateTimeFormatOptions) => date.toLocaleDateString(undefined, { ...options, timeZone: 'UTC' })

/** First day of the week for the device locale (Android uses the locale's too); Sunday if unknown. */
function firstWeekday(): number {
  try {
    const locale = new Intl.Locale(Intl.DateTimeFormat().resolvedOptions().locale) as Intl.Locale & { weekInfo?: { firstDay: number }; getWeekInfo?: () => { firstDay: number } }
    const firstDay = locale.getWeekInfo?.().firstDay ?? locale.weekInfo?.firstDay ?? 7
    return firstDay % 7
  } catch {
    return 0
  }
}

// DatePickerDialog (360 × 568 pt, 28 pt corners): a 120 pt header (title, headline, mode toggle),
// a divider, a 56 pt month row and a 7 × 7 grid of 48 pt cells inset 12 pt.
function DatePickerDialog({ value, accent, confirmLabel, dismissLabel, onConfirm, onDismiss }: DialogProps) {
  const palette = useMaterialPalette().picker
  const regular = useMaterialFont('Roboto-Regular')
  const medium = useMaterialFont('Roboto-Medium')
  const [selected, setSelected] = useState(() => utcDay(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()))
  const [month, setMonth] = useState(() => ({ year: value.getUTCFullYear(), month: value.getUTCMonth() }))
  const [mode, setMode] = useState<'calendar' | 'years' | 'input'>('calendar')
  const [typed, setTyped] = useState(() => inputText(selected))
  const now = new Date()
  const today = utcDay(now.getFullYear(), now.getMonth(), now.getDate())
  const firstDay = useMemo(firstWeekday, [])
  const weekdays = Array.from({ length: 7 }, (_, index) => format(utcDay(2023, 0, 1 + ((firstDay + index) % 7)), { weekday: 'narrow' }))
  const offset = (utcDay(month.year, month.month, 1).getUTCDay() - firstDay + 7) % 7
  const days = new Date(Date.UTC(month.year, month.month + 1, 0)).getUTCDate()
  const shiftMonth = (delta: number) => setMonth(current => {
    const next = utcDay(current.year, current.month + delta, 1)
    return { year: next.getUTCFullYear(), month: next.getUTCMonth() }
  })
  const header = <>
    <Text style={[styles.label, styles.absolute, { left: 24, top: capTop(20.2, 14, 0.9), color: accent, fontFamily: medium }]}>Select date</Text>
    <Text numberOfLines={1} style={[styles.headline, { top: capTop(70.5, 32, 0.5), color: accent, fontFamily: regular }]}>{format(selected, { month: 'short', day: 'numeric', year: 'numeric' })}</Text>
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={mode === 'input' ? 'Switch to calendar input mode' : 'Switch to text input mode'}
      onPress={() => { setTyped(inputText(selected)); setMode(current => current === 'input' ? 'calendar' : 'input') }}
      style={[styles.iconButton, { left: 300, top: 58.7 }]}
    ><Icon path={mode === 'input' ? ICON.calendar : ICON.edit} color={accent} /></Pressable>
    <View style={[styles.divider, { top: 119, backgroundColor: palette.divider }]} />
  </>
  const buttons = <DialogButtons top={530.3} items={[
    { label: dismissLabel, left: 233.1, onPress: onDismiss },
    { label: confirmLabel, left: 315, onPress: () => onConfirm(selected) },
  ]} />
  if (mode === 'input') {
    return <DialogFrame width={360} height={568} onDismiss={onDismiss}>
      {header}
      <TextInput
        accessibilityLabel="Date"
        autoFocus
        keyboardType="number-pad"
        value={typed}
        placeholder="mm/dd/yyyy"
        placeholderTextColor={palette.muted}
        onChangeText={text => {
          const digits = text.replace(/\D/g, '').slice(0, 8)
          const next = [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4)].filter(Boolean).join('/')
          setTyped(next)
          const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(next)
          const date = match ? utcDay(Number(match[3]), Number(match[1]) - 1, Number(match[2])) : null
          if (date && date.getUTCMonth() === Number(match![1]) - 1) setSelected(date)
        }}
        style={[styles.dateInput, { color: palette.text, borderColor: accent, fontFamily: regular }]}
      />
      {buttons}
    </DialogFrame>
  }
  return <DialogFrame width={360} height={568} onDismiss={onDismiss}>
    {header}
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${format(utcDay(month.year, month.month, 1), { month: 'long', year: 'numeric' })}, ${mode === 'years' ? 'close' : 'choose'} year`}
      onPress={() => setMode(current => current === 'years' ? 'calendar' : 'years')}
      style={styles.monthButton}
    >
      <Text style={[styles.label, { color: palette.muted, fontFamily: medium }]}>{format(utcDay(month.year, month.month, 1), { month: 'long', year: 'numeric' })}</Text>
      <View style={styles.dropDown}><Icon path={ICON.dropDown} color={palette.muted} rotate={mode === 'years'} /></View>
    </Pressable>
    {mode === 'years'
      ? <ScrollView style={styles.years} contentContainerStyle={styles.yearsContent} contentOffset={{ x: 0, y: Math.max(0, Math.floor((month.year - 1900) / 3) * 52 - 104) }}>
          {Array.from({ length: 201 }, (_, index) => 1900 + index).map(year => {
            const current = year === month.year
            return <Pressable key={year} accessibilityRole="button" accessibilityLabel={String(year)} accessibilityState={{ selected: current }} onPress={() => { setMonth(value => ({ ...value, year })); setMode('calendar') }} style={styles.yearCell}>
              <View style={[styles.yearPill, current && { backgroundColor: accent }, !current && year === today.getUTCFullYear() && { borderWidth: 1, borderColor: accent }]}>
                <Text style={[styles.body, { color: current ? palette.onAccent : year === today.getUTCFullYear() ? accent : palette.muted, fontFamily: regular }]}>{year}</Text>
              </View>
            </Pressable>
          })}
        </ScrollView>
      : <>
          <Pressable accessibilityRole="button" accessibilityLabel="Change to previous month" onPress={() => shiftMonth(-1)} style={[styles.iconButton, { left: 252, top: 124.5 }]}><Icon path={ICON.previous} color={palette.muted} /></Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="Change to next month" onPress={() => shiftMonth(1)} style={[styles.iconButton, { left: 300, top: 124.5 }]}><Icon path={ICON.next} color={palette.muted} /></Pressable>
          {weekdays.map((weekday, index) => <Text key={index} style={[styles.body, styles.cellText, { left: 12 + 48 * index, top: capTop(193.9, 16), color: palette.text, fontFamily: regular }]}>{weekday}</Text>)}
          {Array.from({ length: days }, (_, index) => {
            const day = index + 1
            const cell = offset + index
            const date = utcDay(month.year, month.month, day)
            const isSelected = date.getTime() === selected.getTime()
            const isToday = date.getTime() === today.getTime()
            return <Pressable
              key={day}
              accessibilityRole="button"
              accessibilityLabel={format(date, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
              accessibilityState={{ selected: isSelected }}
              onPress={() => setSelected(date)}
              style={[styles.dayCell, { left: 12 + 48 * (cell % 7), top: 224 + 48 * Math.floor(cell / 7) }]}
            >
              <View style={[styles.dayCircle, isSelected && { backgroundColor: accent }, !isSelected && isToday && { borderWidth: 1, borderColor: accent }]}>
                <Text style={[styles.body, { color: isSelected ? palette.onAccent : isToday ? accent : palette.text, fontFamily: regular }]}>{day}</Text>
              </View>
            </Pressable>
          })}
        </>}
    {buttons}
  </DialogFrame>
}

function inputText(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())}/${date.getUTCFullYear()}`
}

// TimePicker (vertical layout) in an AlertDialog: 320 × 516 pt, 24 pt padding, a 96 × 80 pt hour
// and minute field, an AM/PM toggle, and a 256 pt clock dial with labels on a 101 pt radius.
const DIAL_LEFT = 32
const DIAL_TOP = 140.2
const DIAL_RADIUS = 128
const LABEL_RADIUS = 101

function TimePickerDialog({ value, accent, confirmLabel, dismissLabel, onConfirm, onDismiss, is24Hour }: DialogProps & { is24Hour: boolean }) {
  const palette = useMaterialPalette().picker
  const regular = useMaterialFont('Roboto-Regular')
  const medium = useMaterialFont('Roboto-Medium')
  const [hour, setHour] = useState(value.getHours())
  const [minute, setMinute] = useState(value.getMinutes())
  const [selecting, setSelecting] = useState<'hour' | 'minute'>('hour')
  const pm = hour >= 12
  const pad = (number: number) => String(number).padStart(2, '0')
  const shownHour = is24Hour ? hour : hour % 12 || 12
  const labels = selecting === 'hour'
    ? Array.from({ length: 12 }, (_, index) => ({ value: index === 0 ? 12 : index, text: String(index === 0 ? 12 : index) }))
    : Array.from({ length: 12 }, (_, index) => ({ value: index * 5, text: pad(index * 5) }))
  const selectedStep = selecting === 'hour' ? (hour % 12) / 12 : minute / 60
  const angle = selectedStep * 2 * Math.PI - Math.PI / 2
  const selector = { x: DIAL_RADIUS + LABEL_RADIUS * Math.cos(angle), y: DIAL_RADIUS + LABEL_RADIUS * Math.sin(angle) }
  const pick = (event: GestureResponderEvent, release: boolean) => {
    const { locationX, locationY } = event.nativeEvent
    const turn = (Math.atan2(locationY - DIAL_RADIUS, locationX - DIAL_RADIUS) + Math.PI / 2 + 2 * Math.PI) % (2 * Math.PI) / (2 * Math.PI)
    if (selecting === 'hour') {
      const step = Math.round(turn * 12) % 12
      setHour((pm ? 12 : 0) + step)
      if (release) setSelecting('minute')
    } else {
      setMinute(Math.round(turn * 60) % 60)
    }
  }
  const field = (part: 'hour' | 'minute', text: string, left: number) => {
    const active = selecting === part
    return <Pressable
      accessibilityRole="button"
      accessibilityLabel={part === 'hour' ? `Select hour, ${text}` : `Select minutes, ${text}`}
      accessibilityState={{ selected: active }}
      onPress={() => setSelecting(part)}
      style={[styles.timeField, { left, backgroundColor: active ? accent : palette.fieldContainer }]}
    ><Text style={[styles.timeDigits, { color: active ? palette.onAccentContainer : palette.text, fontFamily: regular }]}>{text}</Text></Pressable>
  }
  const period = (label: 'AM' | 'PM', top: number) => {
    const active = (label === 'PM') === pm
    return <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
      onPress={() => { if (!active) setHour(current => (current + 12) % 24) }}
      style={[styles.periodHalf, { top }, active && { backgroundColor: palette.periodSelected }]}
    ><Text style={[styles.period, { color: active ? palette.onPeriodSelected : palette.muted, fontFamily: medium }]}>{label}</Text></Pressable>
  }
  return <DialogFrame width={320} height={516} onDismiss={onDismiss}>
    {field('hour', pad(shownHour), 24)}
    <Text style={[styles.timeDigits, styles.absolute, { left: 120, width: 24, top: 24, lineHeight: 80, color: palette.text, fontFamily: regular }]}>:</Text>
    {field('minute', pad(minute), 144)}
    {is24Hour ? null : <View style={[styles.periodBox, { borderColor: palette.outline }]}>
      {period('AM', 0)}
      <View style={[styles.periodDivider, { backgroundColor: palette.outline }]} />
      {period('PM', 40)}
    </View>}
    <View
      style={[styles.dial, { backgroundColor: `${accent}4d` }]}
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onResponderGrant={event => pick(event, false)}
      onResponderMove={event => pick(event, false)}
      onResponderRelease={event => pick(event, true)}
    >
      <Svg width={DIAL_RADIUS * 2} height={DIAL_RADIUS * 2} pointerEvents="none" style={StyleSheet.absoluteFill}>
        <Path d={`M ${DIAL_RADIUS} ${DIAL_RADIUS} L ${selector.x} ${selector.y}`} stroke={accent} strokeWidth={2} />
      </Svg>
      <View pointerEvents="none" style={[styles.selector, { left: selector.x - 24, top: selector.y - 24, backgroundColor: accent }]} />
      <View pointerEvents="none" style={[styles.centerDot, { backgroundColor: accent }]} />
      {labels.map((label, index) => {
        const labelAngle = (index / 12) * 2 * Math.PI - Math.PI / 2
        const active = selecting === 'hour' ? label.value === shownHour % 12 || (label.value === 12 && shownHour === 12) : label.value === minute
        return <Text key={label.text} pointerEvents="none" style={[styles.body, styles.dialLabel, {
          left: DIAL_RADIUS + LABEL_RADIUS * Math.cos(labelAngle) - 24,
          top: DIAL_RADIUS + LABEL_RADIUS * Math.sin(labelAngle) - 12,
          color: active ? palette.onAccent : palette.text,
          fontFamily: regular,
        }]}>{label.text}</Text>
      })}
    </View>
    <DialogButtons top={462.5} items={[
      { label: dismissLabel, left: 175.2, onPress: onDismiss },
      { label: confirmLabel, left: 257.1, onPress: () => { const date = new Date(value); date.setHours(hour, minute); onConfirm(date) } },
    ]} />
  </DialogFrame>
}

const styles = StyleSheet.create({
  center: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, alignItems: 'center', justifyContent: 'center' },
  card: { borderRadius: 28, overflow: 'hidden' },
  absolute: { position: 'absolute' },
  label: { fontSize: 14, letterSpacing: 0.1 },
  body: { fontSize: 16, letterSpacing: 0.5 },
  headline: { position: 'absolute', left: 24, right: 60, fontSize: 32 },
  iconButton: { position: 'absolute', width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  divider: { position: 'absolute', left: 0, right: 0, height: 1 },
  textButton: { position: 'absolute', height: 40, paddingHorizontal: 12, justifyContent: 'center' },
  monthButton: { position: 'absolute', left: 12, top: 124.5, height: 48, paddingLeft: 12, paddingRight: 4, flexDirection: 'row', alignItems: 'center' },
  dropDown: { marginLeft: 8 },
  cellText: { position: 'absolute', width: 48, textAlign: 'center' },
  dayCell: { position: 'absolute', width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  dayCircle: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  years: { position: 'absolute', left: 12, right: 12, top: 176, height: 336 },
  yearsContent: { flexDirection: 'row', flexWrap: 'wrap', paddingVertical: 16 },
  yearCell: { width: 112, height: 52, alignItems: 'center', justifyContent: 'center' },
  yearPill: { width: 72, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  dateInput: { position: 'absolute', left: 24, right: 24, top: 136, height: 56, borderWidth: 2, borderRadius: 4, paddingHorizontal: 16, fontSize: 16 },
  timeField: { position: 'absolute', top: 24, width: 96, height: 80, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  timeDigits: { fontSize: 57, textAlign: 'center' },
  periodBox: { position: 'absolute', left: 252, top: 24, width: 44, height: 80, borderWidth: 1, borderRadius: 8, overflow: 'hidden' },
  periodHalf: { position: 'absolute', left: 0, right: 0, height: 38.5, alignItems: 'center', justifyContent: 'center' },
  periodDivider: { position: 'absolute', left: 0, right: 0, top: 38.5, height: 1 },
  period: { fontSize: 16, letterSpacing: 0.15 },
  dial: { position: 'absolute', left: DIAL_LEFT, top: DIAL_TOP, width: DIAL_RADIUS * 2, height: DIAL_RADIUS * 2, borderRadius: DIAL_RADIUS },
  selector: { position: 'absolute', width: 48, height: 48, borderRadius: 24 },
  centerDot: { position: 'absolute', left: DIAL_RADIUS - 4, top: DIAL_RADIUS - 4, width: 8, height: 8, borderRadius: 4 },
  dialLabel: { position: 'absolute', width: 48, textAlign: 'center' },
})
