import { ref } from 'vue'

const networkState = ref({
  connected: false,
  ping: 0,
  players: 0,
})

function useNetworkState() {
  return { networkState }
}

export default useNetworkState
