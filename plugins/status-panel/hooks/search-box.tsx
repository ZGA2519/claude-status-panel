// The Activity search field, drawn by the panel itself: the surface's own Input keeps a fixed width,
// this one fills the row. Typing stays here; Enter, Search and Clear post to the hooks module.
import type { ClientModule } from 'claude-code'

/** `isTerminal`: the CLI draws the bordered field 3 rows tall, so the buttons drop one row to its text line.
 *  `channel`: rides on every post, so the hooks module knows which search it is (absent: Activity's). */
type Props = { value: string; placeholder: string; isTerminal?: boolean; channel?: string }
type State = { text: string; seen: string; isFocused: boolean }

const SearchBox: ClientModule<Props, State> = (props, surface) => {
  const { Box, Text, Button } = surface.elements
  if (surface.state === undefined) {
    surface.setState({ text: props.value, seen: props.value, isFocused: false })
    const now = () => surface.state ?? { text: '', seen: '', isFocused: true }
    surface.onPointer(ev => {
      if (ev.type === 'down' && !now().isFocused) surface.setState({ ...now(), isFocused: true })
    })
    surface.onKey(ev => {
      const s = now()
      if (ev.key === 'return') return surface.post({ type: 'search', text: s.text, channel: props.channel ?? null })
      let text = s.text
      if (ev.key === 'backspace' || ev.key === 'delete') text = text.slice(0, -1)
      else if (ev.key === 'space') text += ' '
      else if (ev.key.length === 1 && !ev.ctrl && !ev.meta) text += ev.key
      else return
      surface.setState({ ...s, text, isFocused: true })
    })
  }
  const s = surface.state ?? { text: props.value, seen: props.value, isFocused: false }
  // the panel changed the applied search (Clear, a new session): follow it
  if (props.value !== s.seen) surface.setState({ ...s, text: props.value, seen: props.value })

  const cursor = s.isFocused ? '▏' : ''
  return (
    <Box flexDirection="row" gap={1} alignItems="center" width="100%">
      <Box flexGrow={1} borderStyle="round" borderColor={s.isFocused ? 'suggestion' : undefined} borderDimColor={!s.isFocused} paddingX={1}>
        {s.text ? (
          <Text wrap="truncate-start">
            {s.text}
            {cursor}
          </Text>
        ) : (
          <Text dimColor wrap="truncate-end">
            {cursor}
            {props.placeholder}
          </Text>
        )}
      </Box>
      <Box flexDirection="row" gap={1} marginTop={props.isTerminal ? 1 : 0} alignSelf={props.isTerminal ? "flex-start" : "center"}>
        <Button key="sb-go" label="Search" variant="primary" onPress={() => surface.post({ type: 'search', text: s.text, channel: props.channel ?? null })} />
        <Button
          key="sb-clear"
          label="Clear"
          onPress={() => {
            surface.setState({ ...s, text: '' })
            surface.post({ type: 'clear', channel: props.channel ?? null })
          }}
        />
      </Box>
    </Box>
  )
}

export default SearchBox
