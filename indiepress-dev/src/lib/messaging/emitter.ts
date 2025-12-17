type Handler<T> = (payload: T) => void

export class SimpleEmitter<T> {
  private listeners = new Map<string, Set<Handler<T>>>()

  on(event: string, handler: Handler<T>) {
    const handlers = this.listeners.get(event) || new Set<Handler<T>>()
    handlers.add(handler)
    this.listeners.set(event, handlers)
    return () => this.off(event, handler)
  }

  off(event: string, handler: Handler<T>) {
    const handlers = this.listeners.get(event)
    handlers?.delete(handler)
  }

  count(event: string) {
    return this.listeners.get(event)?.size || 0
  }

  emit(event: string, payload: T) {
    const handlers = this.listeners.get(event)
    handlers?.forEach((h) => h(payload))
  }

  removeAllListeners() {
    this.listeners.clear()
  }
}
