import { ref } from 'vue'

const store = ref({
  inWorld: false,
  playerName: '',
})

function useStore() {
  return { store }
}

export default useStore
